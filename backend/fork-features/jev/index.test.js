import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_KEY = 'jev-test-key-not-a-real-secret';
const MODEL = 'test/decision-model';
const MAX_RESPONSE_BYTES = 1048576;
const QUESTIONS = {
  consent: { kind: 'noul', instructions: 'Does the sender request a reply?' },
  routing: {
    kind: 'choice',
    instructions: 'Choose the team responsible for this request.',
    criteria: { billing: 'Invoices and payments', technical: 'Technical support', sales: 'New sales' },
  },
  mood: {
    kind: 'score',
    instructions: 'Assess the frustration expressed by the sender.',
    criteria: ['Calm', 'Mildly annoyed', 'Frustrated', 'Angry'],
  },
};
const WIRE_ANSWERS = {
  consent: { type: 'noul', noul: 0.91 },
  routing: {
    type: 'choice', choice: 'billing', confidence: 1,
    probabilities: { billing: 1, technical: 0, sales: 0 },
  },
  mood: {
    type: 'score', score: 2.01, confidence: 0.9,
    legend: { 0: 'Calm', 1: 'Mildly annoyed', 2: 'Frustrated', 3: 'Angry' },
    probabilities: { 0: 0, 1: 0.04, 2: 0.9, 3: 0.06 },
  },
};
const PUBLIC_ANSWERS = {
  consent: { kind: 'noul', probability: 0.91 },
  routing: {
    kind: 'choice', choice: 'billing', confidence: 1,
    probabilities: { billing: 1, technical: 0, sales: 0 },
  },
  mood: {
    kind: 'score', score: 2.01, confidence: 0.9,
    probabilities: { 0: 0, 1: 0.04, 2: 0.9, 3: 0.06 },
    legend: { 0: 'Calm', 1: 'Mildly annoyed', 2: 'Frustrated', 3: 'Angry' },
  },
};

function responsePayload() {
  return { model: 'typesafe/jev', answers: structuredClone(WIRE_ANSWERS), usage: { input_tokens: 428 } };
}

function sendJson(response, payload = responsePayload()) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    // Hung-response tests must release their sockets even if an assertion fails.
    server.closeAllConnections();
  });
}

let sequence = 0;
let stateMarkers;
let errors;
let server;
let requests;
let handler;
let received;
let decide;
let status;
let warn;

function request() {
  const marker = `PRIVATE_JEV_STATE_${++sequence}`;
  stateMarkers.push(marker);
  return {
    state: `${marker}\nFrom: sender@example.test\nPlease fix my invoice — urgently.\n`,
    questions: structuredClone(QUESTIONS),
  };
}

async function call(input = request(), options) {
  const result = await decide(input, options);
  if (result.kind === 'error') errors.push(result);
  return result;
}

function expectError(result, error) {
  expect(result).toEqual({ kind: 'error', error });
}

beforeEach(async () => {
  requests = [];
  stateMarkers = [];
  errors = [];
  handler = (_request, response) => sendJson(response);
  let recordReceived;
  received = new Promise(resolve => { recordReceived = resolve; });
  server = createServer((incoming, response) => {
    const record = { method: incoming.method, headers: incoming.headers, body: null };
    requests.push(record);
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      record.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      recordReceived(record);
      handler(incoming, response);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  vi.stubEnv('JEV_BASE_URL', `http://127.0.0.1:${server.address().port}/decision`);
  vi.stubEnv('JEV_API_KEY', TEST_KEY);
  vi.stubEnv('JEV_MODEL', MODEL);
  vi.stubEnv('LOG_LEVEL', 'warn');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Each import owns its warning throttle; fake timers would interfere with real sockets.
  vi.resetModules();
  ({ decide, status } = await import('./index.js'));
});

afterEach(async () => {
  try {
    const logs = JSON.stringify(warn.mock.calls);
    const returnedErrors = JSON.stringify(errors);
    expect(logs).not.toContain(TEST_KEY);
    expect(returnedErrors).not.toContain(TEST_KEY);
    for (const marker of stateMarkers) {
      expect(logs).not.toContain(marker);
      expect(returnedErrors).not.toContain(marker);
    }
  } finally {
    await closeServer(server);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe('Jev decision client over HTTP', () => {
  const invalidRequests = [
    ['choice with one label', input => { input.questions.routing.criteria = { billing: 'Invoices' }; },
      'questions.routing.criteria must have 2-24 labels'],
    ['choice with 25 labels', input => {
      input.questions.routing.criteria = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`label${i}`, `Description ${i}`]));
    }, 'questions.routing.criteria must have 2-24 labels'],
    ['score with 11 tiers', input => { input.questions.mood.criteria = Array.from({ length: 11 }, (_, i) => `Tier ${i}`); },
      'questions.mood.criteria must have 2-10 tiers'],
    ['score with one tier', input => { input.questions.mood.criteria = ['Calm']; },
      'questions.mood.criteria must have 2-10 tiers'],
    ['empty instructions', input => { input.questions.consent.instructions = ''; },
      'questions.consent.instructions must be a non-empty string'],
    ['whitespace instructions', input => { input.questions.consent.instructions = ' \t\n '; },
      'questions.consent.instructions must be a non-empty string'],
    ['unknown kind', input => { input.questions.consent.kind = 'boolean'; },
      'questions.consent.kind must be noul, choice or score'],
    ['non-string state', input => { input.state = { privateState: input.state }; }, 'state must be a string'],
    ['null questions', input => { input.questions = null; }, 'questions must be an object of id to question'],
    ['array questions', input => { input.questions = []; }, 'questions must be an object of id to question'],
    ['string questions', input => { input.questions = 'questions'; }, 'questions must be an object of id to question'],
  ];

  it.each(invalidRequests)('rejects %s before network or configuration lookup', async (_name, mutate, detail) => {
    const input = request();
    mutate(input);
    expectError(await call(input), { kind: 'invalid_request', detail });
    vi.stubEnv('JEV_API_KEY', '');
    expectError(await call(input), { kind: 'invalid_request', detail });
    expect(requests).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not send an unconfigured decision and reports live configuration changes', async () => {
    vi.stubEnv('JEV_API_KEY', '');
    expectError(await call(), { kind: 'unconfigured' });
    expect(status()).toEqual({ kind: 'unconfigured' });
    expect(requests).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    vi.stubEnv('JEV_API_KEY', TEST_KEY);
    expect(status()).toEqual({ kind: 'configured', baseUrl: process.env.JEV_BASE_URL, model: MODEL });
    vi.stubEnv('JEV_BASE_URL', undefined);
    vi.stubEnv('JEV_MODEL', undefined);
    expect(status()).toEqual({
      kind: 'configured', baseUrl: 'https://api.commandcode.ai/provider/v1/systemone', model: 'typesafe/jev',
    });
    vi.stubEnv('JEV_API_KEY', undefined);
    expect(status()).toEqual({ kind: 'unconfigured' });
    expectError(await call(), { kind: 'unconfigured' });
    expect(requests).toHaveLength(0);
  });

  it('sends authenticated POST JSON preserving state and translating every question kind', async () => {
    const input = request();
    expect(await call(input)).toEqual({ kind: 'ok', answers: PUBLIC_ANSWERS, model: 'typesafe/jev', inputTokens: 428 });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(requests[0].headers['content-type']).toBe('application/json');
    expect(requests[0].body).toEqual({
      model: MODEL,
      state: input.state,
      questions: {
        consent: { type: 'noul', instructions: QUESTIONS.consent.instructions },
        routing: { type: 'choice', instructions: QUESTIONS.routing.instructions, criteria: QUESTIONS.routing.criteria },
        mood: { type: 'score', instructions: QUESTIONS.mood.instructions, criteria: QUESTIONS.mood.criteria },
      },
    });
    expect(input.questions).toEqual(QUESTIONS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns exact public answer shapes and null inputTokens when usage is absent', async () => {
    handler = (_request, response) => {
      const payload = responsePayload();
      delete payload.usage;
      sendJson(response, payload);
    };
    expect(await call()).toEqual({ kind: 'ok', answers: PUBLIC_ANSWERS, model: 'typesafe/jev', inputTokens: null });
    expect(requests).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [429, '7', { kind: 'rate_limited', retryAfterMs: 7000 }],
    [429, undefined, { kind: 'rate_limited', retryAfterMs: null }],
    [500, undefined, { kind: 'http', status: 500 }],
    [401, undefined, { kind: 'http', status: 401 }],
  ])('maps HTTP %i and Retry-After %s to an exact error', async (code, retryAfter, expected) => {
    handler = (_request, response) => {
      response.writeHead(code, retryAfter === undefined ? {} : { 'Retry-After': retryAfter });
      response.end('not a decision response');
    };
    expectError(await call(), expected);
    expect(requests).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[warn]');
  });

  it('converts an HTTP-date Retry-After relative to the current clock', async () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    handler = (_request, response) => {
      response.writeHead(429, { 'Retry-After': new Date(now + 9000).toUTCString() });
      response.end();
    };
    expectError(await call(), { kind: 'rate_limited', retryAfterMs: 9000 });
    expect(requests).toHaveLength(1);
  });

  const invalidResponses = [
    ['missing answer ids', payload => { payload.answers = {}; }, 'answers must have exactly the question ids'],
    ['extra answer id', payload => { payload.answers.unrequested = { type: 'noul', noul: 0.5 }; },
      'answers must have exactly the question ids'],
    ['string noul value', payload => { payload.answers.consent.noul = '0.91'; }, 'answers.consent.noul must be a probability'],
    ['out-of-range noul value', payload => { payload.answers.consent.noul = 1.5; }, 'answers.consent.noul must be a probability'],
    ['choice outside criteria', payload => { payload.answers.routing.choice = 'other'; }, 'answers.routing.choice is not one of the criteria'],
    ['missing choice probability label', payload => { delete payload.answers.routing.probabilities.sales; },
      'answers.routing.probabilities must have exactly the criteria labels'],
    ['extra choice probability label', payload => { payload.answers.routing.probabilities.other = 0; },
      'answers.routing.probabilities must have exactly the criteria labels'],
    ['out-of-range choice probability', payload => { payload.answers.routing.probabilities.billing = 1.1; },
      'answers.routing.probabilities must be probabilities'],
    ['out-of-range confidence', payload => { payload.answers.routing.confidence = -0.1; }, 'answers.routing.confidence must be a probability'],
    ['score above last tier', payload => { payload.answers.mood.score = 4; }, 'answers.mood.score must be within 0-3'],
    ['legend unlike criteria', payload => { payload.answers.mood.legend[2] = 'Different tier'; },
      'answers.mood.legend does not match the criteria'],
    ['missing legend tier', payload => { delete payload.answers.mood.legend[3]; }, 'answers.mood.legend must have exactly the tier indexes'],
    ['extra legend tier', payload => { payload.answers.mood.legend[4] = 'Extra'; }, 'answers.mood.legend must have exactly the tier indexes'],
    ['missing score probability tier', payload => { delete payload.answers.mood.probabilities[3]; },
      'answers.mood.probabilities must have exactly the tier indexes'],
    ['extra score probability tier', payload => { payload.answers.mood.probabilities[4] = 0; },
      'answers.mood.probabilities must have exactly the tier indexes'],
    ['answer type mismatch', payload => { payload.answers.consent.type = 'choice'; }, 'answers.consent.type does not match the question'],
  ];

  it.each(invalidResponses)('rejects %s in a successful HTTP response', async (_name, mutate, detail) => {
    handler = (_request, response) => {
      const payload = responsePayload();
      mutate(payload);
      sendJson(response, payload);
    };
    expectError(await call(), { kind: 'invalid_response', detail });
    expect(requests).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not JSON', 'not JSON', 'response body is not JSON'],
    ['only an empty answers object', '{"answers":{}}', 'model must be a string'],
    ['2 MiB response', 'x'.repeat(2 * MAX_RESPONSE_BYTES), `response body exceeds ${MAX_RESPONSE_BYTES} bytes`],
    ['one byte over the limit', 'x'.repeat(MAX_RESPONSE_BYTES + 1), `response body exceeds ${MAX_RESPONSE_BYTES} bytes`],
  ])('rejects %s without exposing response text', async (_name, body, detail) => {
    handler = (_request, response) => response.end(body);
    expectError(await call(), { kind: 'invalid_response', detail });
    expect(requests).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid JSON response exactly at the byte limit', async () => {
    const json = JSON.stringify(responsePayload());
    const body = json + ' '.repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(json));
    expect(Buffer.byteLength(body)).toBe(MAX_RESPONSE_BYTES);
    handler = (_request, response) => response.end(body);
    expect(await call()).toEqual({ kind: 'ok', answers: PUBLIC_ANSWERS, model: 'typesafe/jev', inputTokens: 428 });
    expect(requests).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('times out a server that never responds at a shortened 50 ms deadline', async () => {
    handler = () => {};
    expectError(await call(request(), { deadlineMs: 50 }), { kind: 'timeout' });
    expect(requests).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight call after the server receives the request', async () => {
    handler = () => {};
    const controller = new AbortController();
    const pending = call(request(), { signal: controller.signal, deadlineMs: 1000 });
    await received;
    controller.abort();
    expectError(await pending, { kind: 'aborted' });
    expect(requests).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not send a request for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    expectError(await call(request(), { signal: controller.signal }), { kind: 'aborted' });
    expect(requests).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports network failure when the previously bound server port is closed', async () => {
    const url = process.env.JEV_BASE_URL;
    await closeServer(server);
    vi.stubEnv('JEV_BASE_URL', url);
    expectError(await call(), { kind: 'network' });
    expect(requests).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(['[warn]', '[jev] decision failed: endpoint unreachable']);
  });

  it.each([
    ['signal', { signal: {} }, 'options.signal must be an AbortSignal'],
    ['zero deadline', { deadlineMs: 0 }, 'options.deadlineMs must be a positive number'],
    ['non-finite deadline', { deadlineMs: Infinity }, 'options.deadlineMs must be a positive number'],
    ['string deadline', { deadlineMs: '50' }, 'options.deadlineMs must be a positive number'],
  ])('throws TypeError for malformed %s before sending', async (_name, options, message) => {
    await expect(call(request(), options)).rejects.toThrow(TypeError);
    await expect(call(request(), options)).rejects.toThrow(message);
    expect(requests).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('throttles each external error kind independently and reports the suppressed count', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
    handler = (_request, response) => { response.writeHead(500); response.end(); };
    expectError(await call(), { kind: 'http', status: 500 });
    expect(warn.mock.calls).toEqual([['[warn]', '[jev] decision failed: HTTP 500']]);
    clock.mockReturnValue(100001);
    expectError(await call(), { kind: 'http', status: 500 });
    expect(warn).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(159999);
    expectError(await call(), { kind: 'http', status: 500 });
    expect(warn).toHaveBeenCalledTimes(1);
    handler = (_request, response) => { response.writeHead(429); response.end(); };
    expectError(await call(), { kind: 'rate_limited', retryAfterMs: null });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]).toEqual(['[warn]', '[jev] decision failed: rate limited, retry after unspecified ms']);
    clock.mockReturnValue(160001);
    handler = (_request, response) => { response.writeHead(401); response.end(); };
    expectError(await call(), { kind: 'http', status: 401 });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2]).toEqual(['[warn]', '[jev] decision failed: HTTP 401 (2 more since the last warning)']);
    clock.mockReturnValue(220002);
    expectError(await call(), { kind: 'http', status: 401 });
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[3]).toEqual(['[warn]', '[jev] decision failed: HTTP 401']);
    expect(requests).toHaveLength(6);
  });
});
