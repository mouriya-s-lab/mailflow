// Reputation tags are snapshots; retry keeps an unknown snapshot available while improving it.
export const REVISION = 0;
// Match Jev's existing budgets and retry policy; these are not plugin settings.
export const TICK_BUDGET_MS = 60_000;
export const TICK_MAX_MESSAGES = 50;
export const MIN_MESSAGE_BUDGET_MS = 5_000;
export const NEW_MAIL_MARK_LIMIT = 200;
export const BACKFILL_BATCH = 50;
export const QUEUE_READ_LIMIT = 200;
export const MAX_ATTEMPTS = 5;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const corrupt = what => { throw new Error(`reputation-tags: malformed stored ${what}`); };

export function parseFloors(value) {
  if (!record(value)) return corrupt('UID floors');
  return Object.fromEntries(Object.entries(value).map(([path, floor]) => {
    if (!record(floor) || !count(floor.uidValidity) || !count(floor.nextUid)) return corrupt('UID floor');
    return [path, { uidValidity: floor.uidValidity, nextUid: floor.nextUid }];
  }));
}

export function refreshFloors(stored, current) {
  const floors = { ...stored };
  let changed = false;
  for (const [path, floor] of Object.entries(current)) {
    if (!stored[path] || stored[path].uidValidity !== floor.uidValidity) {
      floors[path] = floor;
      changed = true;
    }
  }
  return { floors, changed };
}

function verdict(source, value) {
  if (!record(value)) return corrupt('source verdict');
  switch (value.kind) {
    case 'known':
      if (source === 'rdap' && timestamp(value.registeredAt)) return { kind: 'known', registeredAt: value.registeredAt };
      break;
    case 'not_found':
      if (source === 'rdap') return { kind: 'not_found' };
      break;
    case 'listed':
      if (source !== 'rdap' && typeof value.detail === 'string') return { kind: 'listed', detail: value.detail };
      break;
    case 'not_listed':
      if (source !== 'rdap') return { kind: 'not_listed' };
      break;
    case 'unknown':
      if (['timeout', 'rate_limited', 'error', ...(source === 'rdap' ? ['unsupported_tld'] : [])].includes(value.reason)) {
        return { kind: 'unknown', reason: value.reason };
      }
      break;
    default:
      break;
  }
  return corrupt('source verdict');
}

export function parseResult(source, value) {
  if (!record(value) || value.kind !== 'complete' || !timestamp(value.checkedAt) || !record(value.subjects)) return corrupt('result');
  const subjects = Object.fromEntries(Object.entries(value.subjects).map(([subject, raw]) => {
    if (source !== 'safe_browsing') return [subject, verdict(source, raw)];
    if (!/^[0-9a-f]{64}$/.test(subject) || !record(raw) || typeof raw.host !== 'string' || !raw.host) return corrupt('URL subject');
    return [subject, { host: raw.host, verdict: verdict(source, raw.verdict) }];
  }));
  return { kind: 'complete', checkedAt: value.checkedAt, subjects };
}

export function parseAnnotation(source, raw) {
  if (raw == null) return null;
  if (!record(raw) || !count(raw.revision) || !record(raw.queue)
    || !['pending', 'retry', 'done', 'terminal'].includes(raw.queue.state)
    || !['new_mail', 'backfill'].includes(raw.queue.origin)
    || !(raw.queue.dueAt === null || timestamp(raw.queue.dueAt))
    || (raw.queue.state === 'retry' && !timestamp(raw.queue.dueAt))
    || (raw.attempts !== undefined && !count(raw.attempts))) return corrupt('annotation');
  return {
    revision: raw.revision, queue: { ...raw.queue }, attempts: raw.attempts ?? 0,
    ...(raw.result === undefined ? {} : { result: parseResult(source, raw.result) }),
  };
}

export function bodyGate(outcome) {
  if (!outcome) return 'deadline';
  switch (outcome.kind) {
    case 'stored':
    case 'fetched':
    case 'empty': return 'ready';
    case 'unavailable':
      switch (outcome.reason) {
        case 'deadline': return 'deadline';
        case 'provider_refusing':
        case 'imap_error':
        case 'message_missing': return 'body_unavailable';
        default: throw new Error(`reputation-tags: unknown body reason ${outcome.reason}`);
      }
    default: throw new Error(`reputation-tags: unknown body outcome ${outcome.kind}`);
  }
}

export function failedAttempt(annotation, errorKind, now, result) {
  const attempts = annotation.attempts + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  return {
    revision: REVISION, attempts, errorKind,
    queue: {
      state: exhausted ? 'done' : 'retry',
      dueAt: exhausted ? null : new Date(now.getTime() + 2 ** attempts * 60_000).toISOString(),
      origin: annotation.queue.origin,
    },
    result,
  };
}

export function parseBackfill(value) {
  if (value == null || value.kind === 'idle') return { kind: 'idle' };
  if (!record(value) || !count(value.revision) || !timestamp(value.startedAt)
    || !count(value.marked) || !count(value.processed) || !count(value.failed)) return corrupt('backfill');
  const common = { revision: value.revision, startedAt: value.startedAt, marked: value.marked, processed: value.processed, failed: value.failed };
  switch (value.kind) {
    case 'running': return { kind: 'running', ...common };
    case 'completed':
      if (timestamp(value.finishedAt)) return { kind: 'completed', ...common, finishedAt: value.finishedAt };
      break;
    case 'stopped':
      if (timestamp(value.stoppedAt)) return { kind: 'stopped', ...common, stoppedAt: value.stoppedAt };
      break;
    default: break;
  }
  return corrupt('backfill');
}

// The SQL reader knows only the public result projection; source-native details remain here.
export function storedReputationObservation(source, raw, facets) {
  const revision = count(raw?.revision) ? raw.revision : null;
  if (facets.includes('unrecognized')) return { kind: 'unrecognized', revision };
  if (raw?.result == null) return { kind: 'none', revision };
  const result = parseResult(source, raw.result);
  if (source === 'rdap') {
    return {
      kind: 'rdap', revision, checkedAt: result.checkedAt,
      subjects: Object.entries(result.subjects).map(([domain, registration]) => ({ domain, registration })),
    };
  }
  return {
    kind: 'listing', revision, source, checkedAt: result.checkedAt,
    subjects: Object.entries(result.subjects).map(([subject, entry]) => source === 'safe_browsing'
      ? { kind: 'url_digest', urlDigest: subject, host: entry.host, verdict: entry.verdict }
      : { kind: 'domain', domain: subject, verdict: entry }),
  };
}
