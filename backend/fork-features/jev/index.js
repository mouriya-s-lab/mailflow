// Jev decision client: sends one state and a set of questions to a Jev endpoint and returns typed
// answers or a typed error. It knows nothing about mail; what the questions mean is the caller's
// business. Contract K2 in mouriya-s-lab/mailflow#5.
//
// The caller passes the configuration `{ baseUrl, model, apiKey }` on every call; inside MailFlow
// it comes from the admin setting (fork-features/service-config), and this module reads no
// environment. A null or empty apiKey means unconfigured.
//
// Every outcome of a decision, invalid questions included, is a value rather than a throw: a caller
// switches on `kind` and decides what to retry, since this module never retries on its own.
// Neither the state nor the key ever reaches a log line or an error object.

import { logger } from '../../src/services/logger.js';

export const JEV_DEFAULTS = Object.freeze({
  baseUrl: 'https://api.commandcode.ai/provider/v1/systemone',
  model: 'typesafe/jev',
});
const MAX_DEADLINE_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CHOICE_LABELS = { min: 2, max: 24 };
const SCORE_TIERS = { min: 2, max: 10 };
const WARN_INTERVAL_MS = 60_000;

const QUESTION_KINDS = ['noul', 'choice', 'score'];

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isProbability = value => typeof value === 'number' && value >= 0 && value <= 1;
const sameKeys = (record, keys) => {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every(key => Object.hasOwn(record, key));
};

class Invalid extends Error {}
const invalid = detail => { throw new Invalid(detail); };

export function status(config) {
  return config.apiKey
    ? { kind: 'configured', baseUrl: config.baseUrl, model: config.model }
    : { kind: 'unconfigured' };
}

// ── Request ───────────────────────────────────────────────────────────────────
// The caller's questions use `kind` like every other variant here; the wire format calls it `type`.

function wireQuestion(id, question) {
  const at = `questions.${id}`;
  if (!isRecord(question)) invalid(`${at} must be an object`);
  if (!QUESTION_KINDS.includes(question.kind)) invalid(`${at}.kind must be noul, choice or score`);
  if (typeof question.instructions !== 'string' || !question.instructions.trim()) invalid(`${at}.instructions must be a non-empty string`);
  const { kind, instructions, criteria } = question;
  switch (kind) {
    case 'noul':
      return { type: kind, instructions };
    case 'choice': {
      if (!isRecord(criteria)) invalid(`${at}.criteria must be an object of label to description`);
      const labels = Object.keys(criteria);
      if (labels.length < CHOICE_LABELS.min || labels.length > CHOICE_LABELS.max) invalid(`${at}.criteria must have ${CHOICE_LABELS.min}-${CHOICE_LABELS.max} labels`);
      if (!labels.every(label => typeof criteria[label] === 'string')) invalid(`${at}.criteria descriptions must be strings`);
      return { type: kind, instructions, criteria: Object.fromEntries(labels.map(label => [label, criteria[label]])) };
    }
    case 'score':
      if (!Array.isArray(criteria) || !criteria.every(tier => typeof tier === 'string')) invalid(`${at}.criteria must be an array of tier labels`);
      if (criteria.length < SCORE_TIERS.min || criteria.length > SCORE_TIERS.max) invalid(`${at}.criteria must have ${SCORE_TIERS.min}-${SCORE_TIERS.max} tiers`);
      return { type: kind, instructions, criteria: [...criteria] };
    default:
      throw new Error(`unhandled question kind ${kind}`);
  }
}

function parseRequest(request) {
  if (!isRecord(request)) invalid('request must be an object');
  if (typeof request.state !== 'string') invalid('state must be a string');
  if (!isRecord(request.questions)) invalid('questions must be an object of id to question');
  const ids = Object.keys(request.questions);
  return {
    state: request.state,
    questions: Object.fromEntries(ids.map(id => [id, wireQuestion(id, request.questions[id])])),
  };
}

// signal and deadlineMs steer the call rather than describe the decision, so a malformed one is a
// programming error in the caller and throws instead of becoming invalid_request.
function parseOptions(options = {}) {
  const { signal, deadlineMs } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('options.signal must be an AbortSignal');
  if (deadlineMs !== undefined && !(typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) && deadlineMs > 0)) {
    throw new TypeError('options.deadlineMs must be a positive number');
  }
  return { signal, deadlineMs: Math.min(deadlineMs ?? MAX_DEADLINE_MS, MAX_DEADLINE_MS) };
}

// ── Response ──────────────────────────────────────────────────────────────────
// The single parse point for Jev answers: every question must come back exactly once, with its own
// type and every value inside its range. Details name the place that failed, never the value.

function parseAnswer(id, question, answer) {
  const at = `answers.${id}`;
  if (!isRecord(answer)) invalid(`${at} must be an object`);
  if (answer.type !== question.type) invalid(`${at}.type does not match the question`);
  switch (question.type) {
    case 'noul':
      if (!isProbability(answer.noul)) invalid(`${at}.noul must be a probability`);
      return { kind: 'noul', probability: answer.noul };
    case 'choice': {
      const labels = Object.keys(question.criteria);
      if (typeof answer.choice !== 'string' || !labels.includes(answer.choice)) invalid(`${at}.choice is not one of the criteria`);
      if (!isProbability(answer.confidence)) invalid(`${at}.confidence must be a probability`);
      const { probabilities } = answer;
      if (!isRecord(probabilities) || !sameKeys(probabilities, labels)) invalid(`${at}.probabilities must have exactly the criteria labels`);
      if (!labels.every(label => isProbability(probabilities[label]))) invalid(`${at}.probabilities must be probabilities`);
      return {
        kind: 'choice',
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(labels.map(label => [label, probabilities[label]])),
      };
    }
    case 'score': {
      const tiers = question.criteria.map((_, index) => String(index));
      const top = tiers.length - 1;
      if (!(typeof answer.score === 'number' && answer.score >= 0 && answer.score <= top)) invalid(`${at}.score must be within 0-${top}`);
      if (!isProbability(answer.confidence)) invalid(`${at}.confidence must be a probability`);
      const { probabilities, legend } = answer;
      if (!isRecord(probabilities) || !sameKeys(probabilities, tiers)) invalid(`${at}.probabilities must have exactly the tier indexes`);
      if (!tiers.every(tier => isProbability(probabilities[tier]))) invalid(`${at}.probabilities must be probabilities`);
      if (!isRecord(legend) || !sameKeys(legend, tiers)) invalid(`${at}.legend must have exactly the tier indexes`);
      if (!tiers.every((tier, index) => legend[tier] === question.criteria[index])) invalid(`${at}.legend does not match the criteria`);
      return {
        kind: 'score',
        score: answer.score,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(tiers.map(tier => [tier, probabilities[tier]])),
        legend: Object.fromEntries(tiers.map((tier, index) => [tier, question.criteria[index]])),
      };
    }
    default:
      throw new Error(`unhandled question type ${question.type}`);
  }
}

function parseResponse(bytes, questions) {
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    invalid('response body is not JSON');
  }
  if (!isRecord(payload)) invalid('response must be an object');
  if (typeof payload.model !== 'string') invalid('model must be a string');
  const { answers, usage } = payload;
  const ids = Object.keys(questions);
  if (!isRecord(answers) || !sameKeys(answers, ids)) invalid('answers must have exactly the question ids');
  if (usage !== undefined && !isRecord(usage)) invalid('usage must be an object');
  const inputTokens = usage?.input_tokens ?? null;
  if (inputTokens !== null && !(typeof inputTokens === 'number' && Number.isFinite(inputTokens))) invalid('usage.input_tokens must be a number');
  return {
    kind: 'ok',
    answers: Object.fromEntries(ids.map(id => [id, parseAnswer(id, questions[id], answers[id])])),
    model: payload.model,
    inputTokens,
  };
}

// ── Transport ─────────────────────────────────────────────────────────────────

function retryAfterMs(header) {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

// Reads at most MAX_RESPONSE_BYTES; returns null past that, which also cancels the stream.
async function readBody(body) {
  if (!body) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function exchange(config, request, { signal, deadlineMs }) {
  if (signal?.aborted) return { kind: 'aborted' };
  const controller = new AbortController();
  let cause = null;
  const stop = reason => {
    if (cause) return;
    cause = reason;
    controller.abort();
  };
  const timer = setTimeout(() => stop('timeout'), deadlineMs);
  const onAbort = () => stop('aborted');
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let response;
    let bytes;
    try {
      response = await fetch(config.baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, state: request.state, questions: request.questions }),
        signal: controller.signal,
      });
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        return response.status === 429
          ? { kind: 'rate_limited', retryAfterMs: retryAfterMs(response.headers.get('retry-after')) }
          : { kind: 'http', status: response.status };
      }
      bytes = await readBody(response.body);
    } catch {
      return { kind: cause ?? 'network' };
    }
    if (bytes === null) return { kind: 'invalid_response', detail: `response body exceeds ${MAX_RESPONSE_BYTES} bytes` };
    try {
      return parseResponse(bytes, request.questions);
    } catch (err) {
      if (err instanceof Invalid) return { kind: 'invalid_response', detail: err.message };
      throw err;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────
// External failures are warned, at most once per kind per interval so an outage cannot flood the
// log. unconfigured is a status, not a failure; invalid_request and aborted are the caller's own.

const lastWarned = new Map();

function warnExternal(error) {
  let line;
  switch (error.kind) {
    case 'unconfigured':
    case 'invalid_request':
    case 'aborted':
      return;
    case 'http': line = `HTTP ${error.status}`; break;
    case 'rate_limited': line = `rate limited, retry after ${error.retryAfterMs ?? 'unspecified'} ms`; break;
    case 'timeout': line = 'deadline passed'; break;
    case 'network': line = 'endpoint unreachable'; break;
    case 'invalid_response': line = `invalid response: ${error.detail}`; break;
    default: throw new Error(`unhandled Jev error kind ${error.kind}`);
  }
  const now = Date.now();
  const previous = lastWarned.get(error.kind);
  if (previous && now - previous.at < WARN_INTERVAL_MS) {
    previous.suppressed++;
    return;
  }
  lastWarned.set(error.kind, { at: now, suppressed: 0 });
  const suppressed = previous?.suppressed ? ` (${previous.suppressed} more since the last warning)` : '';
  logger.warn(`[jev] decision failed: ${line}${suppressed}`);
}

export async function decide(config, request, options) {
  const control = parseOptions(options);
  let parsed;
  try {
    parsed = parseRequest(request);
  } catch (err) {
    if (err instanceof Invalid) return { kind: 'error', error: { kind: 'invalid_request', detail: err.message } };
    throw err;
  }
  if (!config.apiKey) return { kind: 'error', error: { kind: 'unconfigured' } };
  const result = await exchange(config, parsed, control);
  if (result.kind === 'ok') return result;
  warnExternal(result);
  return { kind: 'error', error: result };
}
