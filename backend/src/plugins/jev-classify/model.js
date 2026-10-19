// Jev classification plugin — domain model (K9, mouriya-s-lab/mailflow#5 and #17).
//
// Pure: parsers for everything the plugin stores or receives (categories, account settings, the
// per-message annotation, the backfill run) and the per-message state machine. Nothing here does
// I/O; processor.js and routes.js own the effects.
//
// The annotation `plugin_annotations['jev-classify']` is the plugin's work record for one message:
//   { revision, queue: { state, dueAt, origin }, category: { decision, action }, spam?: { decision, training } }
// `revision` and `queue` follow the work-queue contract (fork-features/work-queue). The segments
// are the facts; `queue` is derived from them by deriveQueue every time they are written, so the
// two never disagree. Every segment is a tagged union on `kind`.

import { reputationUrlSubject } from '../api.js';

export const PLUGIN_ID = 'jev-classify';
export const MAX_ATTEMPTS = 5;
export const DEFAULT_ROUTING_MIN_CONFIDENCE = 0.8;
export const SPAM_AT_LEAST = 0.9;
export const HAM_AT_MOST = 0.1;
export const BODY_CHARS = 8000;
export const MIN_CATEGORIES = 2;
export const MAX_CATEGORIES = 24;
// The tab of mail Jev has not decided, or decided for a category since removed. Not a category:
// users cannot define it, and the Jev question never offers it.
export const OTHER_TAB_ID = 'other';

const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_LABEL_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 1000;
const MAX_FOLDER_CHARS = 255;
const hasControlChars = text => [...text].some(char => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isProbability = value => typeof value === 'number' && value >= 0 && value <= 1;
const isNonEmptyString = value => typeof value === 'string' && value.length > 0;
const isTimestamp = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const unknownFields = (record, allowed) => Object.keys(record).filter(key => !allowed.includes(key));

// A field-level parse result for request bodies: { ok: true, value } | { ok: false, fields }.
const ok = value => ({ ok: true, value });
const rejected = fields => ({ ok: false, fields });

class Corrupt extends Error {
  constructor(what) { super(`jev-classify: stored ${what} is malformed`); }
}

// ── Categories ────────────────────────────────────────────────────────────────

export const DEFAULT_CATEGORIES = Object.freeze({
  revision: 0,
  categories: Object.freeze([
    { id: 'action-required', label: 'Action required', description: 'The recipient personally has to do something: reply, approve, sign, pay or fix something, often by a date.' },
    { id: 'important-update', label: 'Important update', description: 'News the recipient needs to know about an account, service, booking, delivery or case they are part of, with nothing to do right now.' },
    { id: 'personal', label: 'Personal', description: 'Person-to-person conversation with someone the recipient knows, not sent by an organization to many people.' },
    { id: 'money-and-orders', label: 'Money and orders', description: 'Legitimate invoices, receipts, payments, bank and card notices, orders and shipping from the real organization.' },
    { id: 'newsletters', label: 'Newsletters', description: 'Opt-in recurring editorial content, digests and publications the recipient subscribed to.' },
    { id: 'routine-notifications', label: 'Routine notifications', description: 'Automated notices that need no attention: sign-in alerts the recipient expected, status reports, reminders of routine events.' },
    { id: 'cold-outreach', label: 'Cold outreach', description: 'Unsolicited sales, marketing, recruiting or partnership pitches from people or companies the recipient has no relationship with.' },
    { id: 'review', label: 'Review', description: 'Anything that fits none of the other categories, or is suspicious, deceptive or unclear and should be looked at by a person.' },
  ]),
});

function parseCategories(input, path) {
  const fields = {};
  if (!Array.isArray(input)) return { categories: null, fields: { [path]: `must be an array of ${MIN_CATEGORIES}–${MAX_CATEGORIES} categories` } };
  if (input.length < MIN_CATEGORIES || input.length > MAX_CATEGORIES) {
    fields[path] = `must have ${MIN_CATEGORIES}–${MAX_CATEGORIES} categories (got ${input.length})`;
  }
  const seen = new Set();
  const categories = input.map((entry, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(entry)) { fields[at] = 'must be an object { id, label, description }'; return null; }
    for (const extra of unknownFields(entry, ['id', 'label', 'description'])) fields[`${at}.${extra}`] = 'is not a category field';
    const { id } = entry;
    if (typeof id !== 'string' || !CATEGORY_ID.test(id)) fields[`${at}.id`] = 'must be 1–64 characters of a-z, 0-9 and -, starting with a letter or digit';
    else if (seen.has(id)) fields[`${at}.id`] = `duplicates another category id "${id}"`;
    else seen.add(id);
    const label = typeof entry.label === 'string' ? entry.label.trim() : null;
    if (!label || label.length > MAX_LABEL_CHARS) fields[`${at}.label`] = `must be a non-empty name of at most ${MAX_LABEL_CHARS} characters`;
    const description = typeof entry.description === 'string' ? entry.description.trim() : null;
    if (!description || description.length > MAX_DESCRIPTION_CHARS) fields[`${at}.description`] = `must be a non-empty description of at most ${MAX_DESCRIPTION_CHARS} characters`;
    return { id, label, description };
  });
  return { categories, fields };
}

// PUT /categories body: { categories: [{ id, label, description }] }.
export function parseCategoriesBody(body) {
  if (!isRecord(body)) return rejected({ body: 'must be an object { categories }' });
  const fields = {};
  for (const extra of unknownFields(body, ['categories'])) fields[extra] = 'is not a field of this request';
  const parsed = parseCategories(body.categories, 'categories');
  Object.assign(fields, parsed.fields);
  (parsed.categories ?? []).forEach((category, index) => {
    if (category?.id === OTHER_TAB_ID) fields[`categories[${index}].id`] = `"${OTHER_TAB_ID}" is reserved for the Other tab`;
  });
  return Object.keys(fields).length ? rejected(fields) : ok(parsed.categories);
}

// The stored definition (plugin_data value), or the defaults when the user never saved one.
export function storedCategories(value) {
  if (value == null) return DEFAULT_CATEGORIES;
  if (!isRecord(value) || !isCount(value.revision)) throw new Corrupt('category definition');
  const parsed = parseCategories(value.categories, 'categories');
  if (Object.keys(parsed.fields).length) throw new Corrupt('category definition');
  return { revision: value.revision, categories: parsed.categories };
}

// ── Spam judgment prompt ──────────────────────────────────────────────────────
// The question Jev answers for each message's spam decision: the user's text, or the default while
// none is saved. A save applies to decisions made from then on; a decision already made keeps its
// verdict, because spam decisions are not keyed to the category revision.

export const DEFAULT_SPAM_INSTRUCTIONS = 'Is this email spam, a scam, or phishing? Weigh sender authentication, reply-to and link destinations, not only the wording.';
export const MAX_SPAM_INSTRUCTIONS_CHARS = 2000;

// PUT /spam-instructions body: { instructions } with the text, or null to restore the default.
export function parseSpamInstructionsBody(body) {
  if (!isRecord(body)) return rejected({ body: 'must be an object { instructions }' });
  const extra = unknownFields(body, ['instructions']);
  if (extra.length) return rejected(Object.fromEntries(extra.map(key => [key, 'is not a field of this request'])));
  const { instructions } = body;
  if (instructions === null) return ok(null);
  if (typeof instructions !== 'string') return rejected({ instructions: 'must be text, or null for the default' });
  const text = instructions.trim();
  if (!text) return rejected({ instructions: 'must not be empty; send null to restore the default' });
  if (text.length > MAX_SPAM_INSTRUCTIONS_CHARS) return rejected({ instructions: `must be at most ${MAX_SPAM_INSTRUCTIONS_CHARS} characters` });
  return ok(text);
}

// The stored value (plugin_data): { instructions } with null for the default. A missing record is the default too.
export function storedSpamInstructions(value) {
  if (value == null) return null;
  if (!isRecord(value) || !(value.instructions === null || isNonEmptyString(value.instructions))) throw new Corrupt('spam instructions');
  return value.instructions;
}

// What the routes return and the tick asks Jev: the text, and whether it is the user's own.
export const spamInstructionsView = stored => (stored === null
  ? { instructions: DEFAULT_SPAM_INSTRUCTIONS, custom: false }
  : { instructions: stored, custom: true });

// ── Account configuration ─────────────────────────────────────────────────────
// AccountConfig = { enabled, classifyNewMail, newMailFloors, routing, createFolders, trainSpam,
//                   routingMinConfidence }. newMailFloors is kept by the server; a request sets
// the other six (AccountSettings).

export const DEFAULT_ACCOUNT_CONFIG = Object.freeze({
  enabled: false,
  classifyNewMail: false,
  newMailFloors: Object.freeze({}),
  routing: Object.freeze({}),
  createFolders: false,
  trainSpam: false,
  routingMinConfidence: DEFAULT_ROUTING_MIN_CONFIDENCE,
});

const SETTINGS_FIELDS = ['enabled', 'classifyNewMail', 'routing', 'createFolders', 'trainSpam', 'routingMinConfidence'];
const BOOLEAN_SETTINGS = ['enabled', 'classifyNewMail', 'createFolders', 'trainSpam'];

export const isInbox = path => typeof path === 'string' && path.toUpperCase() === 'INBOX';

function folderPathProblem(path) {
  if (typeof path !== 'string' || !path.trim()) return 'must be a folder path';
  if (path.length > MAX_FOLDER_CHARS) return `must be at most ${MAX_FOLDER_CHARS} characters`;
  if (hasControlChars(path)) return 'must not contain control characters';
  if (isInbox(path)) return 'must not be INBOX';
  return null;
}

// PUT /accounts/:id body: the six AccountSettings fields, all required except routingMinConfidence
// (defaults to 0.8). routing maps the user's current category ids to folder paths.
export function parseAccountSettingsBody(body, categoryIds) {
  if (!isRecord(body)) return rejected({ body: 'must be an object with the account settings' });
  const fields = {};
  for (const extra of unknownFields(body, SETTINGS_FIELDS)) {
    fields[extra] = extra === 'newMailFloors' ? 'is kept by the server and cannot be set' : 'is not an account setting';
  }
  for (const name of BOOLEAN_SETTINGS) {
    if (typeof body[name] !== 'boolean') fields[name] = 'must be true or false';
  }
  const routingMinConfidence = body.routingMinConfidence === undefined ? DEFAULT_ROUTING_MIN_CONFIDENCE : body.routingMinConfidence;
  if (!isProbability(routingMinConfidence)) fields.routingMinConfidence = 'must be a number from 0 to 1';
  const routing = {};
  if (!isRecord(body.routing)) {
    fields.routing = 'must be an object mapping category ids to folder paths';
  } else {
    const known = new Set(categoryIds);
    for (const [categoryId, path] of Object.entries(body.routing)) {
      if (!known.has(categoryId)) { fields[`routing.${categoryId}`] = 'is not one of your categories'; continue; }
      const problem = folderPathProblem(path);
      if (problem) fields[`routing.${categoryId}`] = problem;
      else routing[categoryId] = path;
    }
  }
  if (Object.keys(fields).length) return rejected(fields);
  return ok({
    enabled: body.enabled,
    classifyNewMail: body.classifyNewMail,
    routing,
    createFolders: body.createFolders,
    trainSpam: body.trainSpam,
    routingMinConfidence,
  });
}

function parseFloors(value) {
  if (!isRecord(value)) return null;
  const floors = {};
  for (const [folder, floor] of Object.entries(value)) {
    if (!isRecord(floor) || !isCount(floor.uidValidity) || !isCount(floor.nextUid)) return null;
    floors[folder] = { uidValidity: floor.uidValidity, nextUid: floor.nextUid };
  }
  return floors;
}

// The stored account config (plugin_account_config blob); {} — never configured — is the default.
export function storedAccountConfig(value) {
  if (!isRecord(value)) throw new Corrupt('account configuration');
  if (Object.keys(value).length === 0) return DEFAULT_ACCOUNT_CONFIG;
  const floors = parseFloors(value.newMailFloors);
  const { routing } = value;
  const valid = BOOLEAN_SETTINGS.every(name => typeof value[name] === 'boolean')
    && floors !== null
    && isRecord(routing) && Object.values(routing).every(path => folderPathProblem(path) === null)
    && isProbability(value.routingMinConfidence);
  if (!valid) throw new Corrupt('account configuration');
  return {
    enabled: value.enabled,
    classifyNewMail: value.classifyNewMail,
    newMailFloors: floors,
    routing: { ...routing },
    createFolders: value.createFolders,
    trainSpam: value.trainSpam,
    routingMinConfidence: value.routingMinConfidence,
  };
}

// New-mail floors for this tick: a folder without a floor, or whose UIDVALIDITY changed, takes the
// current one; others keep theirs. A folder that dropped out of `current` keeps its floor, so
// mail that arrives while it is briefly unknown is still new when it comes back.
export function refreshFloors(stored, current) {
  const next = { ...stored };
  let changed = false;
  for (const [folder, floor] of Object.entries(current)) {
    const kept = stored[folder];
    if (!kept || kept.uidValidity !== floor.uidValidity) {
      next[folder] = { uidValidity: floor.uidValidity, nextUid: floor.nextUid };
      changed = true;
    }
  }
  return { floors: next, changed };
}

// ── Backfill run ──────────────────────────────────────────────────────────────
// idle | running { revision, startedAt, marked, processed, failed }
//      | completed { revision, startedAt, finishedAt, marked, processed, failed }
//      | stopped { revision, startedAt, stoppedAt, marked, processed, failed }
// `processed` counts messages of the run that reached done or terminal; `failed` those terminal.

export const IDLE_BACKFILL = Object.freeze({ kind: 'idle' });

export function storedBackfill(value) {
  if (value == null) return IDLE_BACKFILL;
  const counters = isRecord(value) && isCount(value.revision) && isTimestamp(value.startedAt)
    && isCount(value.marked) && isCount(value.processed) && isCount(value.failed);
  switch (value?.kind) {
    case 'idle':
      return IDLE_BACKFILL;
    case 'running':
      if (counters) return { kind: 'running', revision: value.revision, startedAt: value.startedAt, marked: value.marked, processed: value.processed, failed: value.failed };
      break;
    case 'completed':
      if (counters && isTimestamp(value.finishedAt)) return { kind: 'completed', revision: value.revision, startedAt: value.startedAt, finishedAt: value.finishedAt, marked: value.marked, processed: value.processed, failed: value.failed };
      break;
    case 'stopped':
      if (counters && isTimestamp(value.stoppedAt)) return { kind: 'stopped', revision: value.revision, startedAt: value.startedAt, stoppedAt: value.stoppedAt, marked: value.marked, processed: value.processed, failed: value.failed };
      break;
    default:
      break;
  }
  throw new Corrupt('backfill run');
}

// ── Incidents ─────────────────────────────────────────────────────────────────
// Server changes MailFlow could not follow locally (moved_unlocated): { messageId, target, outcome, at }.

export function storedIncidents(value) {
  if (value == null) return [];
  const list = value?.incidents;
  const valid = Array.isArray(list) && list.every(item => isRecord(item)
    && (item.messageId === null || typeof item.messageId === 'string')
    && isNonEmptyString(item.target) && isNonEmptyString(item.outcome) && isTimestamp(item.at));
  if (!valid) throw new Corrupt('incident list');
  return list.map(({ messageId, target, outcome, at }) => ({ messageId, target, outcome, at }));
}

export function storedStats(value) {
  if (value == null) return { lastDecidedAt: null };
  if (!isRecord(value) || !(value.lastDecidedAt === null || isTimestamp(value.lastDecidedAt))) throw new Corrupt('account statistics');
  return { lastDecidedAt: value.lastDecidedAt };
}

// ── Per-message annotation ────────────────────────────────────────────────────

const QUEUE_STATES = ['pending', 'retry', 'done', 'terminal'];
const QUEUE_ORIGINS = ['backfill', 'new_mail'];
const ACTION_SKIP_REASONS = ['spam', 'not_in_inbox', 'low_confidence', 'unmapped', 'no_message_id', 'decision_failed'];
const TRAINING_SKIP_REASONS = ['decision_failed', 'disabled'];
const LABELS = ['spam', 'ham'];
const nullableString = value => value === null || typeof value === 'string';

function parseCategoryDecision(d) {
  switch (d?.kind) {
    case 'pending': return { kind: 'pending' };
    case 'retry':
      if (isCount(d.attempts) && isNonEmptyString(d.errorKind) && isTimestamp(d.dueAt)) return { kind: 'retry', attempts: d.attempts, errorKind: d.errorKind, dueAt: d.dueAt };
      break;
    case 'done':
      if (isCount(d.revision) && typeof d.model === 'string' && isTimestamp(d.decidedAt) && isNonEmptyString(d.choice) && isProbability(d.confidence)) {
        return { kind: 'done', revision: d.revision, model: d.model, decidedAt: d.decidedAt, choice: d.choice, confidence: d.confidence };
      }
      break;
    case 'terminal_failed':
      if (isNonEmptyString(d.errorKind)) return { kind: 'terminal_failed', errorKind: d.errorKind };
      break;
    default: break;
  }
  throw new Corrupt('category decision');
}

function parseAction(a) {
  switch (a?.kind) {
    case 'blocked': return { kind: 'blocked' };
    case 'pending': return { kind: 'pending' };
    case 'retry':
      if (nullableString(a.target) && isCount(a.attempts) && isNonEmptyString(a.outcome) && isTimestamp(a.dueAt)) return { kind: 'retry', target: a.target, attempts: a.attempts, outcome: a.outcome, dueAt: a.dueAt };
      break;
    case 'done':
      if (isNonEmptyString(a.target) && (a.effect === 'moved' || a.effect === 'labeled')) return { kind: 'done', target: a.target, effect: a.effect };
      break;
    case 'skipped':
      if (ACTION_SKIP_REASONS.includes(a.reason)) return { kind: 'skipped', reason: a.reason };
      break;
    case 'terminal_failed':
      if (nullableString(a.target) && isNonEmptyString(a.outcome)) return { kind: 'terminal_failed', target: a.target, outcome: a.outcome };
      break;
    default: break;
  }
  throw new Corrupt('category action');
}

function parseSpamDecision(d) {
  switch (d?.kind) {
    case 'pending': return { kind: 'pending' };
    case 'retry':
      if (isCount(d.attempts) && isNonEmptyString(d.errorKind) && isTimestamp(d.dueAt)) return { kind: 'retry', attempts: d.attempts, errorKind: d.errorKind, dueAt: d.dueAt };
      break;
    case 'done':
      if (typeof d.model === 'string' && isTimestamp(d.decidedAt) && isProbability(d.probability)) return { kind: 'done', model: d.model, decidedAt: d.decidedAt, probability: d.probability };
      break;
    case 'skipped':
      if (d.reason === 'disabled') return { kind: 'skipped', reason: 'disabled' };
      break;
    case 'terminal_failed':
      if (isNonEmptyString(d.errorKind)) return { kind: 'terminal_failed', errorKind: d.errorKind };
      break;
    default: break;
  }
  throw new Corrupt('spam decision');
}

function parseTraining(t) {
  switch (t?.kind) {
    case 'blocked': return { kind: 'blocked' };
    case 'below_threshold': return { kind: 'below_threshold' };
    case 'no_message_id': return { kind: 'no_message_id' };
    case 'pending':
    case 'recorded':
    case 'duplicate':
    case 'terminal_failed':
      if (LABELS.includes(t.label)) return { kind: t.kind, label: t.label };
      break;
    case 'retry':
      if (LABELS.includes(t.label) && isCount(t.attempts) && isTimestamp(t.dueAt)) return { kind: 'retry', label: t.label, attempts: t.attempts, dueAt: t.dueAt };
      break;
    case 'skipped':
      if (TRAINING_SKIP_REASONS.includes(t.reason)) return { kind: 'skipped', reason: t.reason };
      break;
    default: break;
  }
  throw new Corrupt('spam training');
}

// The plugin's namespace of a queued row: { revision, queue, category | null, spam | null }.
export function parseAnnotation(raw) {
  if (!isRecord(raw) || !isCount(raw.revision) || !isRecord(raw.queue)
    || !QUEUE_STATES.includes(raw.queue.state) || !QUEUE_ORIGINS.includes(raw.queue.origin)
    || !(raw.queue.dueAt === null || isTimestamp(raw.queue.dueAt))) {
    throw new Corrupt('message annotation');
  }
  const category = raw.category == null ? null : { decision: parseCategoryDecision(raw.category.decision), action: parseAction(raw.category.action) };
  const spam = raw.spam == null ? null : { decision: parseSpamDecision(raw.spam.decision), training: parseTraining(raw.spam.training) };
  return { revision: raw.revision, queue: { state: raw.queue.state, dueAt: raw.queue.dueAt, origin: raw.queue.origin }, category, spam };
}

// ── State machine ─────────────────────────────────────────────────────────────
// `lines` = { category: { decision, action }, spam: { decision, training } | null }.

const FRESH_CATEGORY = Object.freeze({ decision: { kind: 'pending' }, action: { kind: 'blocked' } });
const FRESH_SPAM = Object.freeze({ decision: { kind: 'pending' }, training: { kind: 'blocked' } });
const SPAM_DISABLED = Object.freeze({ kind: 'skipped', reason: 'disabled' });
const TRAINING_OPEN = new Set(['blocked', 'pending', 'retry']);

// The marking rules: fill in or reset the lines of an annotation for this attempt.
export function normalize(annotation, { trainSpam }) {
  let { category } = annotation;
  if (!category) category = FRESH_CATEGORY;
  else if (category.decision.kind === 'done' && category.decision.revision !== annotation.revision) category = FRESH_CATEGORY;

  let { spam } = annotation;
  if (trainSpam) {
    if (!spam || (spam.decision.kind === 'skipped' && spam.decision.reason === 'disabled')) spam = FRESH_SPAM;
  } else if (spam) {
    if (spam.decision.kind !== 'done') spam = { decision: SPAM_DISABLED, training: SPAM_DISABLED };
    else if (TRAINING_OPEN.has(spam.training.kind)) spam = { decision: spam.decision, training: SPAM_DISABLED };
  }
  return { category, spam };
}

export const labelFor = probability => (probability >= SPAM_AT_LEAST ? 'spam' : probability <= HAM_AT_MOST ? 'ham' : null);

// Unblock what waits on a decision: done opens it, terminal_failed skips it.
export function promote({ category, spam }) {
  let { action } = category;
  if (action.kind === 'blocked') {
    if (category.decision.kind === 'done') action = { kind: 'pending' };
    else if (category.decision.kind === 'terminal_failed') action = { kind: 'skipped', reason: 'decision_failed' };
  }
  let nextSpam = spam;
  if (spam && spam.training.kind === 'blocked') {
    if (spam.decision.kind === 'done') {
      const label = labelFor(spam.decision.probability);
      nextSpam = { decision: spam.decision, training: label ? { kind: 'pending', label } : { kind: 'below_threshold' } };
    } else if (spam.decision.kind === 'terminal_failed') {
      nextSpam = { decision: spam.decision, training: { kind: 'skipped', reason: 'decision_failed' } };
    }
  }
  return { category: { decision: category.decision, action }, spam: nextSpam };
}

// A segment runs this attempt when it is pending, or a retry that is due.
export const executable = (segment, now) =>
  segment.kind === 'pending' || (segment.kind === 'retry' && Date.parse(segment.dueAt) <= now.getTime());

// Which Jev questions this attempt asks.
export function questionsDue(lines, now) {
  return {
    category: executable(lines.category.decision, now),
    spam: Boolean(lines.spam) && executable(lines.spam.decision, now),
  };
}

// One more failed attempt: retry with backoff 2^attempts minutes, or terminal after MAX_ATTEMPTS.
export function nextAttempt(previous, now) {
  const attempts = (previous.kind === 'retry' ? previous.attempts : 0) + 1;
  if (attempts >= MAX_ATTEMPTS) return { terminal: true, attempts };
  return { terminal: false, attempts, dueAt: new Date(now.getTime() + 2 ** attempts * 60_000).toISOString() };
}

// How a Jev error is handled: { kind: 'unconfigured' } | { kind: 'retry' | 'terminal', errorKind }.
export function classifyJevError(error) {
  switch (error.kind) {
    case 'unconfigured':
      return { kind: 'unconfigured' };
    case 'timeout':
    case 'network':
    case 'rate_limited':
    case 'aborted':
      return { kind: 'retry', errorKind: error.kind };
    case 'http':
      return { kind: error.status >= 500 ? 'retry' : 'terminal', errorKind: `http_${error.status}` };
    case 'invalid_request':
    case 'invalid_response':
      return { kind: 'terminal', errorKind: error.kind };
    default:
      throw new Error(`jev-classify: unhandled Jev error kind ${JSON.stringify(error.kind)}`);
  }
}

// Whether a message whose decisions are due can be asked, from its body outcome
// (ensureMessageBodies): { kind: 'ask' } with its body stored, or none on the server;
// { kind: 'wait' } when it has no outcome or the deadline came first, so it stays queued as it
// is; { kind: 'fail', failure } when the body could not be had, so no state without it is sent.
const BODY_UNAVAILABLE = Object.freeze({ kind: 'retry', errorKind: 'body_unavailable' });
export function bodyGate(outcome) {
  if (!outcome) return { kind: 'wait' };
  switch (outcome.kind) {
    case 'stored':
    case 'fetched':
    case 'empty':
      return { kind: 'ask' };
    case 'unavailable':
      switch (outcome.reason) {
        case 'deadline':
          return { kind: 'wait' };
        case 'provider_refusing':
        case 'imap_error':
        case 'message_missing':
          return { kind: 'fail', failure: BODY_UNAVAILABLE };
        default:
          throw new Error(`jev-classify: unhandled body unavailability ${JSON.stringify(outcome.reason)}`);
      }
    default:
      throw new Error(`jev-classify: unhandled body outcome ${JSON.stringify(outcome.kind)}`);
  }
}

// Record a failed decision attempt (`failure` = { kind: 'retry' | 'terminal', errorKind }) on
// each decision that was asked.
export function failDecisions(lines, asked, failure, now) {
  const fail = decision => {
    const attempt = nextAttempt(decision, now);
    if (failure.kind === 'terminal' || attempt.terminal) return { kind: 'terminal_failed', errorKind: failure.errorKind };
    return { kind: 'retry', attempts: attempt.attempts, errorKind: failure.errorKind, dueAt: attempt.dueAt };
  };
  return {
    category: asked.category ? { decision: fail(lines.category.decision), action: lines.category.action } : lines.category,
    spam: asked.spam ? { decision: fail(lines.spam.decision), training: lines.spam.training } : lines.spam,
  };
}

// Record Jev's answers on each decision that was asked.
export function applyAnswers(lines, asked, { answers, model }, { revision, now }) {
  const decidedAt = now.toISOString();
  const category = asked.category
    ? { decision: { kind: 'done', revision, model, decidedAt, choice: answers.category.choice, confidence: answers.category.confidence }, action: lines.category.action }
    : lines.category;
  const spam = asked.spam
    ? { decision: { kind: 'done', model, decidedAt, probability: answers.spam.probability }, training: lines.spam.training }
    : lines.spam;
  return { category, spam };
}

// The training outcome of one recordJevSpamVerdict result (message_missing is the caller's).
export function trainingOutcome(label, result) {
  switch (result.kind) {
    case 'recorded': return { kind: 'recorded', label };
    case 'duplicate': return { kind: 'duplicate', label };
    case 'no_message_id': return { kind: 'no_message_id' };
    default: throw new Error(`jev-classify: unhandled training result ${JSON.stringify(result.kind)}`);
  }
}

export function failTraining(training, now) {
  const attempt = nextAttempt(training, now);
  if (attempt.terminal) return { kind: 'terminal_failed', label: training.label };
  return { kind: 'retry', label: training.label, attempts: attempt.attempts, dueAt: attempt.dueAt };
}

export function failAction(action, target, outcome, now) {
  const attempt = nextAttempt(action, now);
  if (attempt.terminal) return { kind: 'terminal_failed', target, outcome };
  return { kind: 'retry', target, attempts: attempt.attempts, outcome, dueAt: attempt.dueAt };
}

// The action for a verified-move outcome; `incident` is set for a move the server made that
// MailFlow could not follow.
export function actionForMove(action, target, outcome, now) {
  switch (outcome.kind) {
    case 'moved':
    case 'already_there':
      return { action: { kind: 'done', target, effect: 'moved' }, incident: false };
    case 'no_message_id':
      return { action: { kind: 'skipped', reason: 'no_message_id' }, incident: false };
    case 'folder_missing':
      return { action: { kind: 'terminal_failed', target, outcome: 'folder_missing' }, incident: false };
    case 'moved_unlocated':
      return { action: { kind: 'terminal_failed', target, outcome: 'moved_unlocated' }, incident: true };
    case 'source_changed':
    case 'uidvalidity_unknown':
    case 'uidvalidity_changed':
      return { action: failAction(action, target, outcome.kind, now), incident: false };
    case 'failed':
      return { action: failAction(action, target, `failed_${outcome.reason}`, now), incident: false };
    default:
      throw new Error(`jev-classify: unhandled move outcome ${JSON.stringify(outcome.kind)}`);
  }
}

const segmentsOf = ({ category, spam }) => (spam
  ? [category.decision, category.action, spam.decision, spam.training]
  : [category.decision, category.action]);

// The queue a set of segments projects to (origin is kept by the caller).
export function deriveQueue(lines) {
  const segments = segmentsOf(lines);
  if (segments.some(s => s.kind === 'pending')) return { state: 'pending', dueAt: null };
  const retries = segments.filter(s => s.kind === 'retry').map(s => s.dueAt).sort();
  if (retries.length) return { state: 'retry', dueAt: retries[0] };
  if (segments.some(s => s.kind === 'terminal_failed')) return { state: 'terminal', dueAt: null };
  return { state: 'done', dueAt: null };
}

// retry-failed: every terminal_failed segment back to its runnable start, and a segment skipped
// because its decision failed back to waiting on that decision.
export function resetTerminal({ category, spam }) {
  const reopenAfterDecision = segment => (segment.kind === 'skipped' && segment.reason === 'decision_failed' ? { kind: 'blocked' } : segment);
  let nextCategory = category;
  if (category.decision.kind === 'terminal_failed') nextCategory = { decision: { kind: 'pending' }, action: reopenAfterDecision(category.action) };
  if (nextCategory.action.kind === 'terminal_failed') nextCategory = { decision: nextCategory.decision, action: { kind: 'pending' } };
  let nextSpam = spam;
  if (spam) {
    if (spam.decision.kind === 'terminal_failed') nextSpam = { decision: { kind: 'pending' }, training: reopenAfterDecision(spam.training) };
    if (nextSpam.training.kind === 'terminal_failed') nextSpam = { decision: nextSpam.decision, training: { kind: 'pending', label: nextSpam.training.label } };
  }
  return { category: nextCategory, spam: nextSpam };
}

// ── The Jev request ───────────────────────────────────────────────────────────

const CATEGORY_INSTRUCTIONS = 'Which category does this email belong to? Judge from the sender and its authentication, where the links really go, the mailing-list marks and the content, not only the wording.';

// The first `count` characters (code points, so a surrogate pair is never split).
export function firstChars(text, count) {
  let end = 0;
  let taken = 0;
  for (const char of text) {
    if (taken === count) break;
    end += char.length;
    taken += 1;
  }
  return text.slice(0, end);
}

// The registrable domains the links of a message go to.
export const linkDomains = signals => [...new Set(signals.links.map(link => link.hrefDomain).filter(Boolean))];

// Keep each source's TagState while narrowing a complete snapshot to the current subject.
// A changed body may name a subject absent from an older snapshot; it stays complete, not clean.
function subjectTag(state, subject) {
  return state.kind === 'complete'
    ? { ...state, subjects: Object.hasOwn(state.subjects, subject) ? { [subject]: state.subjects[subject] } : {} }
    : state;
}

// { state, questions } for jevDecide. Existing K5 signals remain intact; new URL tag evidence
// uses only host and the canonical digest, never a second copy of the original URL.
export function buildJevRequest({ signals, reputation, bodyText, categories, spamInstructions, asked }) {
  const domains = {};
  for (const domain of linkDomains(signals)) {
    domains[domain] = Object.fromEntries(
      ['rdap', 'spamhaus_dbl', 'urlhaus'].map(source => [source, subjectTag(reputation[source], domain)]),
    );
  }
  const urls = {};
  for (const link of signals.links) {
    const { urlDigest, host } = reputationUrlSubject(link.href);
    urls[urlDigest] = { host, safe_browsing: subjectTag(reputation.safe_browsing, urlDigest) };
  }
  const questions = {};
  if (asked.category) {
    questions.category = {
      kind: 'choice',
      instructions: CATEGORY_INSTRUCTIONS,
      criteria: Object.fromEntries(categories.map(c => [c.id, c.description])),
    };
  }
  if (asked.spam) questions.spam = { kind: 'noul', instructions: spamInstructions };
  return {
    state: JSON.stringify({ ...signals, linkDomains: domains, linkUrls: urls, bodyText: firstChars(bodyText, BODY_CHARS) }),
    questions,
  };
}

// This is an inspection DTO, not a queue normalization: observing it must never open work.
export function storedSpamObservation(raw, facets) {
  const revision = isCount(raw?.revision) ? raw.revision : null;
  if (facets.includes('unrecognized')) return { kind: 'unrecognized', revision };
  if (raw?.spam == null) return { kind: 'none', revision };
  const decision = parseSpamDecision(raw.spam.decision);
  let training;
  try {
    training = parseTraining(raw.spam.training);
  } catch (error) {
    if (!(error instanceof Corrupt)) throw error;
    training = { kind: 'unrecognized' };
  }
  return {
    kind: 'jev_spam', revision,
    decision: decision.kind === 'done'
      ? { ...decision, outcome: labelFor(decision.probability) ?? 'uncertain' }
      : decision,
    training,
  };
}
