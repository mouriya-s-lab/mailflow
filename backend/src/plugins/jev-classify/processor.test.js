import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The tick against a mocked plugin API: what it marks, what it asks Jev, what it writes back.
// model.js and records.js run for real over in-memory plugin storage.
const store = vi.hoisted(() => ({ data: new Map(), configs: new Map() }));

vi.mock('../api.js', async () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  isPluginActivated: vi.fn(),
  markMessages: vi.fn(),
  currentUidFloors: vi.fn(),
  listQueuedMessages: vi.fn(),
  listMessagesInQueueState: vi.fn(),
  countQueued: vi.fn(),
  setMessageAnnotation: vi.fn(),
  getMessageSignals: vi.fn(),
  getMessageBodyMarkdowns: vi.fn(),
  ensureMessageBodies: vi.fn(),
  ensureMessageTags: vi.fn(),
  reputationUrlSubject: (await vi.importActual('../../../fork-features/reputation/index.js')).reputationUrlSubject,
  jevDecide: vi.fn(),
  recordJevSpamVerdict: vi.fn(),
  requestSpamRetrain: vi.fn(),
  ensureSpamVerdict: vi.fn(),
  moveMessagesVerified: vi.fn(),
  isLabelStoreAccount: vi.fn(),
  applyLabel: vi.fn(),
  ensureLabelFolders: vi.fn(),
  storage: {
    getValue: vi.fn(async (pluginId, key) => (store.data.has(key) ? { key, value: store.data.get(key) } : null)),
    put: vi.fn(async (pluginId, key, { value }) => { store.data.set(key, structuredClone(value)); }),
  },
  getAccountConfig: vi.fn(async (pluginId, accountId) => structuredClone(store.configs.get(accountId) ?? {})),
  setAccountConfig: vi.fn(async (pluginId, accountId, config) => { store.configs.set(accountId, structuredClone(config)); }),
}));

import * as api from '../api.js';
import { runTick, requestDrain, requeueDisabledSpam, newMailDrainActive, jevCallCount, TICK_BUDGET_MS } from './processor.js';
import { DEFAULT_CATEGORIES, DEFAULT_SPAM_INSTRUCTIONS, resetTerminal } from './model.js';
import { clearIncidents } from './records.js';

let accountSeq = 0;
const newAccount = () => {
  accountSeq += 1;
  const id = `00000000-0000-4000-8000-${String(accountSeq).padStart(12, '0')}`;
  return { id, user_id: `user-${accountSeq}`, email_address: `a${accountSeq}@example.com` };
};
const mgr = () => ({ isConnected: () => true, syncFolderViaPool: vi.fn(async () => {}) });

const config = (overrides = {}) => ({
  enabled: true, classifyNewMail: false, newMailFloors: {}, routing: {}, createFolders: false,
  trainSpam: false, routingMinConfidence: 0.8, ...overrides,
});

const pendingQueue = (origin = 'new_mail') => ({ state: 'pending', dueAt: null, origin });
const row = (n, annotation, overrides = {}) => ({
  id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  folder: 'INBOX', uid: String(n), message_id: `<m${n}@mailflow-test.invalid>`,
  date: new Date('2026-10-01T00:00:00Z'), synced_at: new Date('2026-10-01T00:00:00Z'),
  plugin_annotation: annotation, ...overrides,
});
const fresh = (origin = 'new_mail') => ({ revision: 0, queue: pendingQueue(origin) });
const done = (choice = 'money-and-orders', confidence = 0.95) => ({
  kind: 'done', revision: 0, model: 'typesafe/jev', decidedAt: '2026-10-01T00:00:00.000Z', choice, confidence,
});

const signalsFor = links => ({
  sender: { from: { name: 'Bank', email: 'notice@bank.example' }, sender: null, replyTo: [] },
  recipients: { to: 1, cc: 0 },
  subject: 'Your statement',
  date: '2026-10-01T00:00:00.000Z',
  thread: { isReply: false },
  authentication: { kind: 'absent' },
  links,
  attachments: [{ filename: 'statement.pdf', type: 'application/pdf' }],
  mailingList: { listUnsubscribe: null, listId: null, bulk: false },
  language: { resolved: 'en', declared: { htmlLang: null, contentLanguage: null }, script: { dominant: 'Latn', letters: 100 } },
});
const complete = subjects => ({ kind: 'complete', checkedAt: '2026-10-13T00:00:00.000Z', subjects });
const inactiveTags = () => Object.fromEntries(
  ['rdap', 'spamhaus_dbl', 'urlhaus', 'safe_browsing'].map(source => [source, { kind: 'inactive' }]),
);
const answers = ({ choice = 'money-and-orders', confidence = 0.95, probability } = {}) => ({
  kind: 'ok', model: 'typesafe/jev', inputTokens: 100,
  answers: {
    category: { kind: 'choice', choice, confidence, probabilities: {} },
    ...(probability === undefined ? {} : { spam: { kind: 'noul', probability } }),
  },
});
// A Jev stand-in that answers only the questions it was asked.
const answering = (opts = {}) => async request => {
  const result = answers(opts);
  return { ...result, answers: Object.fromEntries(Object.entries(result.answers).filter(([id]) => id in request.questions)) };
};

const patches = () => api.setMessageAnnotation.mock.calls.map(([accountId, id, pluginId, patch]) => ({ accountId, id, pluginId, patch }));
const patchFor = id => patches().find(p => p.id === id)?.patch;

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued once-implementations; drop them so no test inherits another's.
  for (const fn of [api.listQueuedMessages, api.listMessagesInQueueState, api.jevDecide, api.countQueued, api.markMessages, api.setMessageAnnotation, api.ensureMessageTags]) fn.mockReset();
  store.data.clear();
  store.configs.clear();
  api.isPluginActivated.mockResolvedValue(true);
  api.isLabelStoreAccount.mockReturnValue(false);
  api.markMessages.mockResolvedValue(0);
  api.currentUidFloors.mockResolvedValue({});
  api.listQueuedMessages.mockResolvedValue([]);
  api.listMessagesInQueueState.mockResolvedValue([]);
  api.countQueued.mockResolvedValue({ pending: 0, retry: 0, done: 0, terminal: 0 });
  api.setMessageAnnotation.mockResolvedValue({ kind: 'written' });
  api.getMessageSignals.mockImplementation(async (accountId, ids) => new Map(ids.map(id => [id, signalsFor([])])));
  api.getMessageBodyMarkdowns.mockImplementation(async (accountId, ids) => new Map(ids.map(id => [id, { kind: 'ready', document: 'Statement body' }])));
  api.ensureMessageBodies.mockImplementation(async (accountId, ids) => new Map(ids.map(id => [id, { kind: 'stored' }])));
  api.ensureMessageTags.mockImplementation(async (accountId, ids) => new Map(ids.map(id => [id, inactiveTags()])));
  api.jevDecide.mockImplementation(answering());
  api.recordJevSpamVerdict.mockResolvedValue({ kind: 'recorded' });
  api.requestSpamRetrain.mockResolvedValue({ kind: 'retrained', records: 1 });
  api.ensureSpamVerdict.mockResolvedValue({ kind: 'verdict', verdict: 'ham', override: null });
  api.moveMessagesVerified.mockImplementation(async ({ messageIds }) => new Map(messageIds.map(id => [id, { kind: 'moved', uid: 7 }])));
});

describe('one message end to end', () => {
  it('decides, trains, routes and writes every segment with the derived queue once', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ trainSpam: true, routing: { 'money-and-orders': 'MailFlow-Test/Billing' } }));
    const r = row(1, fresh());
    api.listQueuedMessages.mockResolvedValue([r]);
    api.jevDecide.mockImplementation(answering({ probability: 0.02 }));

    await runTick({ mgr: mgr(), account });

    expect(api.jevDecide).toHaveBeenCalledTimes(1);
    expect(Object.keys(api.jevDecide.mock.calls[0][0].questions).sort()).toEqual(['category', 'spam']);
    expect(api.recordJevSpamVerdict).toHaveBeenCalledWith({ messageId: r.id, label: 'ham' });
    expect(api.moveMessagesVerified).toHaveBeenCalledWith({ accountId: account.id, messageIds: [r.id], toFolder: 'MailFlow-Test/Billing' });
    expect(api.setMessageAnnotation).toHaveBeenCalledTimes(1);
    const patch = patchFor(r.id);
    expect(patch.queue).toEqual({ state: 'done', dueAt: null, origin: 'new_mail' });
    expect(patch.category.decision).toMatchObject({ kind: 'done', revision: 0, choice: 'money-and-orders', confidence: 0.95 });
    expect(patch.category.action).toEqual({ kind: 'done', target: 'MailFlow-Test/Billing', effect: 'moved' });
    expect(patch.spam).toMatchObject({ decision: { kind: 'done', probability: 0.02 }, training: { kind: 'recorded', label: 'ham' } });
    expect(api.requestSpamRetrain).toHaveBeenCalledTimes(1);
    expect(api.requestSpamRetrain).toHaveBeenCalledWith(account.user_id);
    expect(jevCallCount(account.id)).toBe(1);
    expect(store.data.get(`account:${account.id}:stats`).lastDecidedAt).toBe(patch.category.decision.decidedAt);
  });

  it('leaves a message outside INBOX unrouted and does not ask anti-spam for it (result 5)', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ trainSpam: true, routing: { 'money-and-orders': 'MailFlow-Test/Billing' } }));
    const r = row(2, fresh(), { folder: 'Junk' });
    api.listQueuedMessages.mockResolvedValue([r]);
    api.jevDecide.mockImplementation(answering({ probability: 0.97 }));

    await runTick({ mgr: mgr(), account });

    expect(patchFor(r.id).category.action).toEqual({ kind: 'skipped', reason: 'not_in_inbox' });
    expect(patchFor(r.id).spam.training).toEqual({ kind: 'recorded', label: 'spam' });
    expect(api.ensureSpamVerdict).not.toHaveBeenCalled();
    expect(api.moveMessagesVerified).not.toHaveBeenCalled();
  });

  it('skips routing for an anti-spam spam verdict, a low confidence and an unmapped category', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ routing: { 'money-and-orders': 'Billing' } }));
    const rows = [row(3, fresh()), row(4, fresh()), row(5, fresh())];
    api.listQueuedMessages.mockResolvedValue(rows);
    api.ensureSpamVerdict.mockImplementation(async id => (id === rows[0].id
      ? { kind: 'verdict', verdict: 'ham', override: 'spam' }
      : { kind: 'disabled' }));
    api.jevDecide.mockImplementationOnce(answering())
      .mockImplementationOnce(answering({ confidence: 0.5 }))
      .mockImplementationOnce(answering({ choice: 'personal' }));

    await runTick({ mgr: mgr(), account });

    expect(patchFor(rows[0].id).category.action).toEqual({ kind: 'skipped', reason: 'spam' });
    expect(patchFor(rows[1].id).category.action).toEqual({ kind: 'skipped', reason: 'low_confidence' });
    expect(patchFor(rows[2].id).category.action).toEqual({ kind: 'skipped', reason: 'unmapped' });
    expect(api.moveMessagesVerified).not.toHaveBeenCalled();
  });

  it('discards the attempt when the row is gone at write time', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    api.listQueuedMessages.mockResolvedValue([row(6, fresh())]);
    api.setMessageAnnotation.mockResolvedValue({ kind: 'message_missing' });
    await runTick({ mgr: mgr(), account });
    expect(store.data.has(`account:${account.id}:stats`)).toBe(false);
  });
});

describe('new mail (row 7)', () => {
  it('marks nothing as new mail while classifyNewMail is off', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ classifyNewMail: false }));
    api.currentUidFloors.mockResolvedValue({ INBOX: { uidValidity: 9, nextUid: 100 } });
    await runTick({ mgr: mgr(), account });
    expect(api.markMessages.mock.calls.filter(([args]) => args.origin === 'new_mail')).toEqual([]);
    expect(api.currentUidFloors).not.toHaveBeenCalled();
  });

  it('takes a new floor when a folder\'s UIDVALIDITY changed, so mail re-ingested under it is not new', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({
      classifyNewMail: true,
      newMailFloors: { INBOX: { uidValidity: 1, nextUid: 10 }, Archive: { uidValidity: 5, nextUid: 40 } },
    }));
    // The server rebuilt INBOX (UIDVALIDITY 2) and sync re-ingested its history as UIDs 1..49.
    api.currentUidFloors.mockResolvedValue({ INBOX: { uidValidity: 2, nextUid: 50 }, Archive: { uidValidity: 5, nextUid: 77 }, Lists: { uidValidity: 3, nextUid: 12 } });

    await runTick({ mgr: mgr(), account });

    const expected = { INBOX: { uidValidity: 2, nextUid: 50 }, Archive: { uidValidity: 5, nextUid: 40 }, Lists: { uidValidity: 3, nextUid: 12 } };
    expect(store.configs.get(account.id).newMailFloors).toEqual(expected);
    expect(api.markMessages).toHaveBeenCalledWith({
      accountId: account.id, pluginId: 'jev-classify', scope: { kind: 'above_uid_floor', floors: expected },
      revision: 0, origin: 'new_mail', limit: 200,
    });
  });
});

describe('Jev failures (row 8)', () => {
  it('changes nothing and stops asking while Jev is unconfigured', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    api.listQueuedMessages.mockResolvedValue([row(10, fresh()), row(11, fresh())]);
    api.jevDecide.mockResolvedValue({ kind: 'error', error: { kind: 'unconfigured' } });
    await runTick({ mgr: mgr(), account });
    expect(api.setMessageAnnotation).not.toHaveBeenCalled();
    expect(api.jevDecide).toHaveBeenCalledTimes(1);
    expect(jevCallCount(account.id)).toBe(0);
  });

  it('retries a 503 with a growing backoff, then fails for good on an invalid response with a warning', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    const now = Date.now();
    api.listQueuedMessages.mockResolvedValueOnce([row(12, fresh())]);
    api.jevDecide.mockResolvedValueOnce({ kind: 'error', error: { kind: 'http', status: 503 } });
    await runTick({ mgr: mgr(), account });
    const first = patchFor(row(12).id);
    expect(first.category.decision).toMatchObject({ kind: 'retry', attempts: 1, errorKind: 'http_503' });
    expect(first.queue).toMatchObject({ state: 'retry', dueAt: first.category.decision.dueAt });
    expect(Date.parse(first.category.decision.dueAt) - now).toBeGreaterThanOrEqual(2 * 60_000);
    expect(Date.parse(first.category.decision.dueAt) - now).toBeLessThan(3 * 60_000);

    api.setMessageAnnotation.mockClear();
    const due = { ...first, category: { ...first.category, decision: { ...first.category.decision, dueAt: new Date(now - 1000).toISOString() } } };
    api.listQueuedMessages.mockResolvedValueOnce([row(12, due)]);
    api.jevDecide.mockResolvedValueOnce({ kind: 'error', error: { kind: 'http', status: 503 } });
    await runTick({ mgr: mgr(), account });
    const second = patchFor(row(12).id);
    expect(second.category.decision).toMatchObject({ kind: 'retry', attempts: 2 });
    expect(Date.parse(second.category.decision.dueAt) - Date.now()).toBeGreaterThanOrEqual(4 * 60_000 - 1000);

    api.setMessageAnnotation.mockClear();
    const dueAgain = { ...second, category: { ...second.category, decision: { ...second.category.decision, dueAt: new Date(now - 1000).toISOString() } } };
    api.listQueuedMessages.mockResolvedValueOnce([row(12, dueAgain)]);
    api.jevDecide.mockResolvedValueOnce({ kind: 'error', error: { kind: 'invalid_response', detail: 'answers.category: missing' } });
    await runTick({ mgr: mgr(), account });
    const third = patchFor(row(12).id);
    expect(third.category).toEqual({ decision: { kind: 'terminal_failed', errorKind: 'invalid_response' }, action: { kind: 'skipped', reason: 'decision_failed' } });
    expect(third.queue).toEqual({ state: 'terminal', dueAt: null, origin: 'new_mail' });
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid_response'));

    // retry-failed resets the segments (resetTerminal); the next tick then completes the message.
    api.setMessageAnnotation.mockClear();
    const reset = resetTerminal({ category: third.category, spam: null });
    api.listQueuedMessages.mockResolvedValueOnce([row(12, { revision: 0, queue: pendingQueue(), category: reset.category })]);
    api.jevDecide.mockImplementationOnce(answering());
    await runTick({ mgr: mgr(), account });
    expect(patchFor(row(12).id).category.action).toEqual({ kind: 'skipped', reason: 'unmapped' });
    expect(patchFor(row(12).id).category.decision.kind).toBe('done');
    expect(patchFor(row(12).id).queue.state).toBe('done');
  });

  it('turns the fifth failed attempt into terminal_failed', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    const ann = { revision: 0, queue: { state: 'retry', dueAt: '2026-01-01T00:00:00.000Z', origin: 'new_mail' },
      category: { decision: { kind: 'retry', attempts: 4, errorKind: 'timeout', dueAt: '2026-01-01T00:00:00.000Z' }, action: { kind: 'blocked' } } };
    api.listQueuedMessages.mockResolvedValue([row(13, ann)]);
    api.jevDecide.mockResolvedValue({ kind: 'error', error: { kind: 'timeout' } });
    await runTick({ mgr: mgr(), account });
    expect(patchFor(row(13).id).category.decision).toEqual({ kind: 'terminal_failed', errorKind: 'timeout' });
  });
});

describe('bodies before Jev (#38 row 4)', () => {
  const outcomes = byId => async (accountId, ids) => new Map(ids.map(id => [id, byId.get(id)]));
  const states = () => api.jevDecide.mock.calls.map(([request]) => JSON.parse(request.state));

  it('asks Jev only with the body stored; a refused, failed or missing body retries body_unavailable without asking', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ trainSpam: true }));
    const [stored, fetched, refused, afterRefusal, failed, missing] = [700, 701, 702, 703, 704, 705].map(n => row(n, fresh()));
    api.listQueuedMessages.mockResolvedValue([stored, fetched, refused, afterRefusal, failed, missing]);
    api.ensureMessageBodies.mockImplementation(outcomes(new Map([
      [stored.id, { kind: 'stored' }],
      [fetched.id, { kind: 'fetched' }],
      [refused.id, { kind: 'unavailable', reason: 'provider_refusing' }],
      [afterRefusal.id, { kind: 'unavailable', reason: 'provider_refusing' }],
      [failed.id, { kind: 'unavailable', reason: 'imap_error' }],
      [missing.id, { kind: 'unavailable', reason: 'message_missing' }],
    ])));
    api.jevDecide.mockImplementation(answering({ probability: 0.02 }));
    const now = Date.now();

    await runTick({ mgr: mgr(), account });

    const asked = [stored.id, fetched.id, refused.id, afterRefusal.id, failed.id, missing.id];
    expect(api.ensureMessageBodies).toHaveBeenCalledWith(account.id, asked, { deadlineMs: expect.any(Number) });
    expect(api.getMessageSignals).toHaveBeenCalledWith(account.id, [stored.id, fetched.id], expect.anything());
    expect(api.getMessageBodyMarkdowns).toHaveBeenCalledWith(account.id, [stored.id, fetched.id]);
    expect(api.jevDecide).toHaveBeenCalledTimes(2);
    expect(states().map(s => s.bodyText)).toEqual(['Statement body', 'Statement body']);
    expect(jevCallCount(account.id)).toBe(2);
    for (const r of [stored, fetched]) expect(patchFor(r.id).category.decision.kind).toBe('done');
    for (const r of [refused, afterRefusal, failed, missing]) {
      const patch = patchFor(r.id);
      expect(patch.category).toEqual({ decision: { kind: 'retry', attempts: 1, errorKind: 'body_unavailable', dueAt: expect.any(String) }, action: { kind: 'blocked' } });
      expect(patch.spam).toEqual({ decision: { kind: 'retry', attempts: 1, errorKind: 'body_unavailable', dueAt: expect.any(String) }, training: { kind: 'blocked' } });
      expect(patch.queue).toEqual({ state: 'retry', dueAt: patch.category.decision.dueAt, origin: 'new_mail' });
      expect(Date.parse(patch.category.decision.dueAt) - now).toBeGreaterThanOrEqual(2 * 60_000);
    }
    expect(api.recordJevSpamVerdict).toHaveBeenCalledTimes(2);
    expect(api.moveMessagesVerified).not.toHaveBeenCalled(); // nothing routed: no routing configured
  });

  it('fails only the unconvertible message terminally and classifies its good batch sibling', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ trainSpam: true }));
    const [bad, good] = [710, 711].map(n => row(n, fresh()));
    api.listQueuedMessages.mockResolvedValue([bad, good]);
    api.getMessageBodyMarkdowns.mockResolvedValue(new Map([
      [bad.id, { kind: 'failed', reason: 'conversion_failed' }],
      [good.id, { kind: 'ready', document: '# Statement\n\n- Amount: **42**' }],
    ]));
    api.jevDecide.mockImplementation(answering({ probability: 0.02 }));

    await runTick({ mgr: mgr(), account });

    expect(api.getMessageBodyMarkdowns).toHaveBeenCalledWith(account.id, [bad.id, good.id]);
    expect(patchFor(bad.id)).toEqual({
      revision: 0,
      queue: { state: 'terminal', dueAt: null, origin: 'new_mail' },
      category: {
        decision: { kind: 'terminal_failed', errorKind: 'body_conversion_failed' },
        action: { kind: 'skipped', reason: 'decision_failed' },
      },
      spam: {
        decision: { kind: 'terminal_failed', errorKind: 'body_conversion_failed' },
        training: { kind: 'skipped', reason: 'decision_failed' },
      },
    });
    expect(api.ensureMessageTags).toHaveBeenCalledTimes(1);
    expect(api.ensureMessageTags).toHaveBeenCalledWith(account.id, [good.id], expect.objectContaining({ deadlineMs: expect.any(Number) }));
    expect(api.jevDecide).toHaveBeenCalledTimes(1);
    expect(states()[0].bodyText).toBe('# Statement\n\n- Amount: **42**');
    expect(patchFor(good.id).category.decision.kind).toBe('done');
    expect(patchFor(good.id).queue.state).toBe('done');
    expect(api.recordJevSpamVerdict).toHaveBeenCalledTimes(1);
    expect(api.recordJevSpamVerdict).toHaveBeenCalledWith({ messageId: good.id, label: 'ham' });
    expect(api.moveMessagesVerified).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining(bad.id));
    expect(jevCallCount(account.id)).toBe(1);
  });

  it('does not classify a missing Markdown result as an empty document or spend its retry attempt', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ trainSpam: true }));
    const annotation = {
      revision: 0, queue: { state: 'retry', dueAt: '2026-01-01T00:00:00.000Z', origin: 'backfill' },
      category: {
        decision: { kind: 'retry', attempts: 2, errorKind: 'body_unavailable', dueAt: '2026-01-01T00:00:00.000Z' },
        action: { kind: 'blocked' },
      },
    };
    const missing = row(712, annotation);
    const empty = row(713, fresh());
    const original = structuredClone(annotation);
    api.listQueuedMessages.mockResolvedValue([missing, empty]);
    api.ensureMessageBodies.mockImplementation(outcomes(new Map([
      [missing.id, { kind: 'stored' }],
      [empty.id, { kind: 'empty' }],
    ])));
    api.getMessageBodyMarkdowns.mockResolvedValue(new Map([[empty.id, { kind: 'ready', document: '' }]]));
    api.jevDecide.mockImplementation(answering({ probability: 0.02 }));

    await runTick({ mgr: mgr(), account });

    expect(api.jevDecide).toHaveBeenCalledTimes(1);
    expect(states()[0]).toMatchObject({ subject: 'Your statement', bodyText: '' });
    expect(api.ensureMessageTags).toHaveBeenCalledTimes(1);
    expect(api.ensureMessageTags).toHaveBeenCalledWith(account.id, [empty.id], expect.anything());
    expect(api.setMessageAnnotation).toHaveBeenCalledTimes(1);
    expect(patchFor(missing.id)).toBeUndefined();
    expect(missing.plugin_annotation).toEqual(original);
    expect(patchFor(empty.id).category.decision.kind).toBe('done');
    expect(api.recordJevSpamVerdict).toHaveBeenCalledTimes(1);
    expect(api.recordJevSpamVerdict).toHaveBeenCalledWith({ messageId: empty.id, label: 'ham' });
    expect(jevCallCount(account.id)).toBe(1);
  });

  it('asks a message whose retried body turns out empty with its headers alone', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    const ann = { revision: 0, queue: { state: 'retry', dueAt: '2026-01-01T00:00:00.000Z', origin: 'new_mail' },
      category: { decision: { kind: 'retry', attempts: 1, errorKind: 'body_unavailable', dueAt: '2026-01-01T00:00:00.000Z' }, action: { kind: 'blocked' } } };
    const r = row(706, ann);
    api.listQueuedMessages.mockResolvedValue([r]);
    api.ensureMessageBodies.mockImplementation(outcomes(new Map([[r.id, { kind: 'empty' }]])));
    api.getMessageBodyMarkdowns.mockImplementation(async (accountId, ids) => new Map(ids.map(id => [id, { kind: 'ready', document: '' }])));

    await runTick({ mgr: mgr(), account });

    expect(api.jevDecide).toHaveBeenCalledTimes(1);
    expect(states()[0]).toMatchObject({ subject: 'Your statement', bodyText: '' });
    expect(patchFor(r.id).category.decision).toMatchObject({ kind: 'done', choice: 'money-and-orders' });
  });

  it('leaves a message the deadline reached before its fetch queued as it is, without spending an attempt', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    const [first, late] = [707, 708].map(n => row(n, fresh()));
    api.listQueuedMessages.mockResolvedValue([first, late]);
    api.ensureMessageBodies.mockImplementation(outcomes(new Map([
      [first.id, { kind: 'fetched' }],
      [late.id, { kind: 'unavailable', reason: 'deadline' }],
    ])));

    await runTick({ mgr: mgr(), account });

    expect(api.jevDecide).toHaveBeenCalledTimes(1);
    expect(patchFor(first.id).category.decision.kind).toBe('done');
    expect(patchFor(late.id)).toBeUndefined();
  });

  it('turns the fifth body_unavailable attempt into terminal_failed', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    const ann = { revision: 0, queue: { state: 'retry', dueAt: '2026-01-01T00:00:00.000Z', origin: 'backfill' },
      category: { decision: { kind: 'retry', attempts: 4, errorKind: 'body_unavailable', dueAt: '2026-01-01T00:00:00.000Z' }, action: { kind: 'blocked' } } };
    const r = row(709, ann);
    api.listQueuedMessages.mockResolvedValue([r]);
    api.ensureMessageBodies.mockImplementation(outcomes(new Map([[r.id, { kind: 'unavailable', reason: 'imap_error' }]])));

    await runTick({ mgr: mgr(), account });

    expect(api.jevDecide).not.toHaveBeenCalled();
    expect(patchFor(r.id).category).toEqual({ decision: { kind: 'terminal_failed', errorKind: 'body_unavailable' }, action: { kind: 'skipped', reason: 'decision_failed' } });
    expect(patchFor(r.id).queue).toEqual({ state: 'terminal', dueAt: null, origin: 'backfill' });
  });
});

describe('switching trainSpam mid-way (row 9b)', () => {
  const categoryDone = { decision: done(), action: { kind: 'done', target: 'Billing', effect: 'moved' } };
  const annotations = () => [
    { revision: 0, queue: pendingQueue(), category: categoryDone, spam: { decision: { kind: 'pending' }, training: { kind: 'blocked' } } },
    { revision: 0, queue: pendingQueue(), category: categoryDone, spam: { decision: { kind: 'retry', attempts: 1, errorKind: 'timeout', dueAt: '2099-01-01T00:00:00.000Z' }, training: { kind: 'blocked' } } },
    { revision: 0, queue: pendingQueue(), category: categoryDone, spam: { decision: { kind: 'done', model: 'typesafe/jev', decidedAt: '2026-10-01T00:00:00.000Z', probability: 0.95 }, training: { kind: 'pending', label: 'spam' } } },
  ];

  it('stops asking spam and training while off, and reinitializes only the undecided lines when on again', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ trainSpam: false }));
    api.listQueuedMessages.mockResolvedValueOnce(annotations().map((a, i) => row(20 + i, a)));
    await runTick({ mgr: mgr(), account });

    const disabled = { kind: 'skipped', reason: 'disabled' };
    const off = [20, 21, 22].map(n => patchFor(row(n).id));
    expect(off[0].spam).toEqual({ decision: disabled, training: disabled });
    expect(off[1].spam).toEqual({ decision: disabled, training: disabled });
    expect(off[2].spam).toEqual({ decision: annotations()[2].spam.decision, training: disabled });
    for (const p of off) expect(p.queue.state).toBe('done');
    expect(api.jevDecide).not.toHaveBeenCalled();
    expect(api.recordJevSpamVerdict).not.toHaveBeenCalled();

    // Switched back on: done rows are never listed by the queue again, so re-queuing has to find
    // the two whose spam line was switched off. What is stored now is the annotation plus the patch.
    const stored = off.map(p => ({ revision: 0, ...p }));
    api.setMessageAnnotation.mockClear();
    store.configs.set(account.id, config({ trainSpam: true }));
    api.listMessagesInQueueState.mockResolvedValueOnce(stored.map((a, i) => row(20 + i, a)));
    expect(await requeueDisabledSpam(account.id)).toBe(2);
    expect(api.listMessagesInQueueState).toHaveBeenCalledWith({ accountId: account.id, pluginId: 'jev-classify', state: 'done', afterId: null, limit: 200 });
    const fresh = { decision: { kind: 'pending' }, training: { kind: 'blocked' } };
    expect(patchFor(row(20).id)).toEqual({ queue: pendingQueue(), category: categoryDone, spam: fresh });
    expect(patchFor(row(21).id)).toEqual({ queue: pendingQueue(), category: categoryDone, spam: fresh });
    expect(patchFor(row(22).id)).toBeUndefined();

    const requeued = [20, 21].map((n, i) => row(n, { ...stored[i], ...patchFor(row(n).id) }));
    api.setMessageAnnotation.mockClear();
    api.listQueuedMessages.mockResolvedValueOnce(requeued);
    api.jevDecide.mockImplementation(async () => ({ kind: 'ok', model: 'typesafe/jev', inputTokens: 1, answers: { spam: { kind: 'noul', probability: 0.5 } } }));
    await runTick({ mgr: mgr(), account });

    expect(api.jevDecide).toHaveBeenCalledTimes(2);
    for (const [request] of api.jevDecide.mock.calls) expect(Object.keys(request.questions)).toEqual(['spam']);
    expect(patchFor(row(20).id).spam).toMatchObject({ decision: { kind: 'done', probability: 0.5 }, training: { kind: 'below_threshold' } });
    expect(patchFor(row(21).id).spam).toMatchObject({ decision: { kind: 'done', probability: 0.5 }, training: { kind: 'below_threshold' } });
    expect(patchFor(row(22).id)).toBeUndefined();
    expect(api.recordJevSpamVerdict).not.toHaveBeenCalled();
  });

  it('re-queues only after the account\'s running tick is over', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    let release;
    api.listQueuedMessages.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const tick = runTick({ mgr: mgr(), account });
    await vi.waitFor(() => expect(api.listQueuedMessages).toHaveBeenCalled());
    const requeue = requeueDisabledSpam(account.id);
    await new Promise(resolve => setImmediate(resolve));
    expect(api.listMessagesInQueueState).not.toHaveBeenCalled();
    release();
    await tick;
    expect(await requeue).toBe(0);
    expect(api.listMessagesInQueueState).toHaveBeenCalledTimes(1);
  });
});

describe('tick budget and single flight (row 10)', () => {
  afterEach(() => vi.useRealTimers());

  it('the inboxIngest handler returns at once and its gate reads memory only', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ classifyNewMail: true }));
    expect(newMailDrainActive(account.id)).toBe(false);
    const result = requestDrain({ mgr: mgr(), account });
    expect(result).toBeUndefined();
    // Nothing ran in the sync loop's call: no activation or config read yet.
    expect(api.isPluginActivated).not.toHaveBeenCalled();
    expect(api.getAccountConfig).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(newMailDrainActive(account.id)).toBe(true));
    expect(api.isPluginActivated).toHaveBeenCalledTimes(1);
    const reads = api.getAccountConfig.mock.calls.length;
    expect(newMailDrainActive(account.id)).toBe(true);
    expect(api.getAccountConfig.mock.calls.length).toBe(reads);
  });

  it('works off at most 50 of 120 queued messages per tick', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    api.listQueuedMessages.mockResolvedValue(Array.from({ length: 120 }, (_, i) => row(100 + i, fresh())));
    await runTick({ mgr: mgr(), account });
    expect(api.jevDecide).toHaveBeenCalledTimes(50);
    expect(api.setMessageAnnotation).toHaveBeenCalledTimes(50);
  });

  it('ends within its 60 s budget when every Jev call takes 20 s, and releases the single flight', async () => {
    vi.useFakeTimers();
    const account = newAccount();
    store.configs.set(account.id, config());
    api.listQueuedMessages.mockResolvedValue(Array.from({ length: 10 }, (_, i) => row(300 + i, fresh())));
    // Like the real client: the answer after 20 s, or `timeout` at the deadline given.
    api.jevDecide.mockImplementation((request, { deadlineMs }) => new Promise(resolve => {
      if (deadlineMs < 20_000) setTimeout(() => resolve({ kind: 'error', error: { kind: 'timeout' } }), deadlineMs);
      else setTimeout(() => resolve(answers()), 20_000);
    }));
    const started = Date.now();
    let finished = null;
    const tick = runTick({ mgr: mgr(), account }).then(() => { finished = Date.now(); });
    expect(runTick({ mgr: mgr(), account })).toBe(runTick({ mgr: mgr(), account })); // joined, not doubled
    await vi.advanceTimersByTimeAsync(TICK_BUDGET_MS + 1000);
    await tick;
    expect(finished - started).toBeLessThanOrEqual(TICK_BUDGET_MS);
    expect(api.jevDecide).toHaveBeenCalledTimes(3);
    for (const [, opts] of api.jevDecide.mock.calls) expect(opts.deadlineMs).toBeLessThanOrEqual(TICK_BUDGET_MS);

    const activationReads = api.isPluginActivated.mock.calls.length;
    const next = runTick({ mgr: mgr(), account });
    await vi.advanceTimersByTimeAsync(TICK_BUDGET_MS + 1000);
    await next;
    expect(api.isPluginActivated.mock.calls.length).toBe(activationReads + 1);
  });
});

describe('the state sent to Jev (row 12)', () => {
  it('carries signals, per-subject TagStates, private URL evidence and the first 8000 body characters', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    const categories = [
      { id: 'bills', label: 'Bills', description: 'Invoices and payment notices.' },
      { id: 'other', label: 'Other', description: 'Anything else.' },
      { id: 'friends', label: 'Friends', description: 'Mail from friends.' },
    ];
    store.data.set(`user:${account.user_id}:categories`, { revision: 3, categories });
    const r = row(400, { revision: 3, queue: pendingQueue() });
    api.listQueuedMessages.mockResolvedValue([r]);
    const links = [
      { href: 'https://login.bank-secure.top/a', hrefHost: 'login.bank-secure.top', hrefDomain: 'bank-secure.top', text: 'https://www.bank.example', textHost: 'www.bank.example', textDomain: 'bank.example', mismatch: true },
      { href: 'https://www.bank.example/help', hrefHost: 'www.bank.example', hrefDomain: 'bank.example', text: 'Help', textHost: null, textDomain: null, mismatch: false },
    ];
    const signals = signalsFor(links);
    api.getMessageSignals.mockResolvedValue(new Map([[r.id, signals]]));
    // A long converted Markdown document, with an astral character straddling 8000.
    const body = `${'x'.repeat(7999)}😀${'tail'.repeat(1000)}`;
    api.getMessageBodyMarkdowns.mockResolvedValue(new Map([[r.id, { kind: 'ready', document: body }]]));
    const urlSubjects = Object.fromEntries(links.map(link => {
      const { urlDigest, host } = api.reputationUrlSubject(link.href);
      return [urlDigest, { host, verdict: { kind: 'listed', detail: 'phishing' } }];
    }));
    const tags = {
      rdap: complete({
        'bank-secure.top': { kind: 'known', registeredAt: '2026-10-05T00:00:00.000Z' },
        'bank.example': { kind: 'unknown', reason: 'timeout' },
        'unrelated.example': { kind: 'not_found' },
      }),
      spamhaus_dbl: { kind: 'unconfigured' },
      urlhaus: { kind: 'unavailable', reason: 'plugin_failed' },
      safe_browsing: complete(urlSubjects),
    };
    api.ensureMessageTags.mockResolvedValue(new Map([[r.id, tags]]));
    api.jevDecide.mockResolvedValue(answers({ choice: 'bills' }));

    await runTick({ mgr: mgr(), account });

    expect(api.ensureMessageTags).toHaveBeenCalledWith(account.id, [r.id], expect.objectContaining({ deadlineMs: expect.any(Number) }));
    const [request] = api.jevDecide.mock.calls[0];
    const state = JSON.parse(request.state);
    for (const [key, value] of Object.entries(signals)) expect(state[key]).toEqual(value);
    expect(state.linkDomains).toEqual({
      'bank-secure.top': { rdap: complete({ 'bank-secure.top': tags.rdap.subjects['bank-secure.top'] }), spamhaus_dbl: tags.spamhaus_dbl, urlhaus: tags.urlhaus },
      'bank.example': { rdap: complete({ 'bank.example': tags.rdap.subjects['bank.example'] }), spamhaus_dbl: tags.spamhaus_dbl, urlhaus: tags.urlhaus },
    });
    expect(state.linkUrls).toEqual(Object.fromEntries(Object.entries(urlSubjects).map(([digest, subject]) => [
      digest, { host: subject.host, safe_browsing: complete({ [digest]: subject }) },
    ])));
    expect(JSON.stringify(state.linkUrls)).not.toContain('https://');
    expect([...state.bodyText].length).toBe(8000);
    expect(state.bodyText).toBe(`${'x'.repeat(7999)}😀`);
    expect(Object.keys(state).sort()).toEqual([...Object.keys(signals), 'bodyText', 'linkDomains', 'linkUrls'].sort());
    expect(state.attachments).toEqual([{ filename: 'statement.pdf', type: 'application/pdf' }]);
    expect(request.questions.category).toEqual({
      kind: 'choice', instructions: expect.any(String),
      criteria: { bills: 'Invoices and payment notices.', other: 'Anything else.', friends: 'Mail from friends.' },
    });
    expect(request.questions.spam).toBeUndefined();
    expect(patchFor(r.id).category.decision).toMatchObject({ kind: 'done', revision: 3, choice: 'bills' });
  });

  it('asks spam with the saved spam prompt, or the default while none is saved', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ trainSpam: true }));
    const r = row(410, fresh());
    api.listQueuedMessages.mockResolvedValue([r]);
    api.getMessageSignals.mockResolvedValue(new Map([[r.id, signalsFor([])]]));
    api.ensureMessageTags.mockResolvedValue(new Map([[r.id, inactiveTags()]]));
    api.jevDecide.mockImplementation(answering({ probability: 0.3 }));

    await runTick({ mgr: mgr(), account });
    expect(api.jevDecide.mock.calls[0][0].questions.spam).toEqual({ kind: 'noul', instructions: DEFAULT_SPAM_INSTRUCTIONS });

    store.data.set(`user:${account.user_id}:spam-instructions`, { instructions: 'Is this a phishing attempt?' });
    await runTick({ mgr: mgr(), account });
    expect(api.jevDecide.mock.calls[1][0].questions.spam).toEqual({ kind: 'noul', instructions: 'Is this a phishing attempt?' });
  });

  it('keeps complete snapshots complete when current links are absent and preserves inactive sources', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    const r = row(402, fresh());
    api.listQueuedMessages.mockResolvedValue([r]);
    const href = 'https://changed.example/path?private=value';
    api.getMessageSignals.mockResolvedValue(new Map([[r.id, signalsFor([{ href, hrefDomain: 'changed.example' }])]]));
    const tags = { ...inactiveTags(), rdap: complete({ 'previous.example': { kind: 'not_found' } }), safe_browsing: complete({}) };
    api.ensureMessageTags.mockResolvedValue(new Map([[r.id, tags]]));
    await runTick({ mgr: mgr(), account });
    const state = JSON.parse(api.jevDecide.mock.calls[0][0].state);
    expect(state.linkDomains['changed.example']).toEqual({ rdap: complete({}), spamhaus_dbl: { kind: 'inactive' }, urlhaus: { kind: 'inactive' } });
    const { urlDigest, host } = api.reputationUrlSubject(href);
    expect(state.linkUrls).toEqual({ [urlDigest]: { host, safe_browsing: complete({}) } });
    expect(state.links[0].href).toBe(href);
  });

  it.each(['rdap', 'spamhaus_dbl', 'urlhaus', 'safe_browsing'])('does not ask, write, or spend an attempt on a %s deadline', async source => {
    const account = newAccount();
    store.configs.set(account.id, config({ trainSpam: true }));
    const annotation = { revision: 0, queue: { state: 'retry', dueAt: '2026-10-01T00:00:00.000Z', origin: 'backfill' },
      category: { decision: { kind: 'retry', attempts: 2, errorKind: 'network', dueAt: '2026-10-01T00:00:00.000Z' }, action: { kind: 'blocked' } } };
    const original = structuredClone(annotation);
    const r = row(403, annotation);
    api.listQueuedMessages.mockResolvedValue([r]);
    api.ensureMessageTags.mockResolvedValue(new Map([[r.id, { ...inactiveTags(), [source]: { kind: 'unavailable', reason: 'deadline' } }]]));
    await runTick({ mgr: mgr(), account });
    expect(api.jevDecide).not.toHaveBeenCalled();
    expect(api.setMessageAnnotation).not.toHaveBeenCalled();
    expect(api.recordJevSpamVerdict).not.toHaveBeenCalled();
    expect(r.plugin_annotation).toEqual(original);
    expect(jevCallCount(account.id)).toBe(0);
  });

  it('retries reputation_error only when the dispatcher itself throws', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    const r = row(404, fresh());
    api.listQueuedMessages.mockResolvedValue([r]);
    api.ensureMessageTags.mockRejectedValue(new Error('database unavailable'));
    await runTick({ mgr: mgr(), account });
    expect(api.jevDecide).not.toHaveBeenCalled();
    expect(patchFor(r.id).category.decision).toMatchObject({ kind: 'retry', attempts: 1, errorKind: 'reputation_error' });
  });

  it('uses the default categories until the user saves some', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    api.listQueuedMessages.mockResolvedValue([row(401, fresh())]);
    await runTick({ mgr: mgr(), account });
    expect(Object.keys(api.jevDecide.mock.calls[0][0].questions.category.criteria)).toEqual(DEFAULT_CATEGORIES.categories.map(c => c.id));
  });
});

describe('a move MailFlow cannot follow (row 14)', () => {
  it('fails the action for good and keeps an incident until it is cleared', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ routing: { 'money-and-orders': 'MailFlow-Test/Billing' } }));
    const r = row(500, fresh());
    api.listQueuedMessages.mockResolvedValue([r]);
    api.moveMessagesVerified.mockResolvedValue(new Map([[r.id, { kind: 'moved_unlocated' }]]));

    await runTick({ mgr: mgr(), account });

    expect(patchFor(r.id).category.action).toEqual({ kind: 'terminal_failed', target: 'MailFlow-Test/Billing', outcome: 'moved_unlocated' });
    expect(patchFor(r.id).queue.state).toBe('terminal');
    const { incidents } = store.data.get(`account:${account.id}:incidents`);
    expect(incidents).toEqual([{ messageId: r.message_id, target: 'MailFlow-Test/Billing', outcome: 'moved_unlocated', at: expect.any(String) }]);
    await clearIncidents(account.id, account.user_id);
    expect(store.data.get(`account:${account.id}:incidents`)).toEqual({ incidents: [] });
  });

  it('retries the other unconfirmed move outcomes', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ routing: { 'money-and-orders': 'Billing' } }));
    const r = row(501, fresh());
    api.listQueuedMessages.mockResolvedValue([r]);
    api.moveMessagesVerified.mockResolvedValue(new Map([[r.id, { kind: 'failed', reason: 'imap_error' }]]));
    await runTick({ mgr: mgr(), account });
    expect(patchFor(r.id).category.action).toMatchObject({ kind: 'retry', target: 'Billing', attempts: 1, outcome: 'failed_imap_error' });
  });
});

describe('folders, labels and pausing', () => {
  it('creates the target with createFolders and syncs it once before moving', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ createFolders: true, routing: { 'money-and-orders': 'MailFlow-Test/Billing' } }));
    const rows = [row(600, fresh()), row(601, fresh())];
    api.listQueuedMessages.mockResolvedValue(rows);
    api.ensureLabelFolders.mockResolvedValue([{ folder: 'MailFlow-Test/Billing', path: 'INBOX/MailFlow-Test/Billing', created: true }]);
    const m = mgr();
    await runTick({ mgr: m, account });
    expect(api.ensureLabelFolders).toHaveBeenCalledTimes(1);
    expect(m.syncFolderViaPool).toHaveBeenCalledTimes(1);
    expect(m.syncFolderViaPool).toHaveBeenCalledWith(account, 'INBOX/MailFlow-Test/Billing');
    expect(api.moveMessagesVerified).toHaveBeenCalledWith(expect.objectContaining({ toFolder: 'INBOX/MailFlow-Test/Billing' }));
  });

  it('labels instead of moving on a label-store account', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ createFolders: true, routing: { 'money-and-orders': 'MailFlow-Test/Billing' } }));
    const r = row(602, fresh());
    api.listQueuedMessages.mockResolvedValue([r]);
    api.isLabelStoreAccount.mockReturnValue(true);
    api.ensureLabelFolders.mockResolvedValue([{ folder: 'MailFlow-Test/Billing', path: 'MailFlow-Test/Billing', created: false }]);
    api.currentUidFloors.mockResolvedValue({ 'MailFlow-Test/Billing': { uidValidity: 1, nextUid: 1 } });
    await runTick({ mgr: mgr(), account });
    expect(api.applyLabel).toHaveBeenCalledWith(account, { account_id: account.id, uid: r.uid, folder: 'INBOX', message_id: r.message_id }, 'MailFlow-Test/Billing');
    expect(api.moveMessagesVerified).not.toHaveBeenCalled();
    expect(patchFor(r.id).category.action).toEqual({ kind: 'done', target: 'MailFlow-Test/Billing', effect: 'labeled' });
  });

  it('neither marks nor processes a disabled account and keeps its backfill running (row 9)', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ enabled: false, classifyNewMail: true }));
    store.data.set(`account:${account.id}:backfill`, { kind: 'running', revision: 0, startedAt: '2026-10-01T00:00:00.000Z', marked: 5, processed: 0, failed: 0 });
    api.listQueuedMessages.mockResolvedValue([row(700, fresh('backfill'))]);
    await runTick({ mgr: mgr(), account });
    expect(api.markMessages).not.toHaveBeenCalled();
    expect(api.listQueuedMessages).not.toHaveBeenCalled();
    expect(store.data.get(`account:${account.id}:backfill`).kind).toBe('running');
  });
});

describe('backfill', () => {
  it('marks the next batch only once the last is worked off, and completes when nothing is left', async () => {
    const account = newAccount();
    store.configs.set(account.id, config());
    store.data.set(`account:${account.id}:backfill`, { kind: 'running', revision: 0, startedAt: '2026-10-01T00:00:00.000Z', marked: 0, processed: 0, failed: 0 });

    api.countQueued.mockResolvedValueOnce({ pending: 3, retry: 0, done: 0, terminal: 0 });
    await runTick({ mgr: mgr(), account });
    expect(api.markMessages).not.toHaveBeenCalled();

    api.countQueued.mockResolvedValueOnce({ pending: 0, retry: 0, done: 3, terminal: 0 });
    api.markMessages.mockResolvedValueOnce(50);
    api.listQueuedMessages.mockResolvedValueOnce([row(800, fresh('backfill'))]);
    await runTick({ mgr: mgr(), account });
    expect(api.markMessages).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'not_at_revision' }, origin: 'backfill', limit: 50, revision: 0 }));
    expect(store.data.get(`account:${account.id}:backfill`)).toMatchObject({ kind: 'running', marked: 50, processed: 1, failed: 0 });

    api.countQueued.mockResolvedValueOnce({ pending: 0, retry: 1, done: 53, terminal: 0 });
    api.markMessages.mockResolvedValueOnce(0);
    await runTick({ mgr: mgr(), account });
    expect(store.data.get(`account:${account.id}:backfill`).kind).toBe('running');

    api.countQueued.mockResolvedValueOnce({ pending: 0, retry: 0, done: 54, terminal: 0 });
    api.markMessages.mockResolvedValueOnce(0);
    await runTick({ mgr: mgr(), account });
    expect(store.data.get(`account:${account.id}:backfill`)).toMatchObject({ kind: 'completed', marked: 50, processed: 1, finishedAt: expect.any(String) });
  });

  it('re-decides only the category of a message decided under an older revision (result 6)', async () => {
    const account = newAccount();
    store.configs.set(account.id, config({ trainSpam: true }));
    store.data.set(`user:${account.user_id}:categories`, { revision: 1, categories: DEFAULT_CATEGORIES.categories });
    const spamDone = { decision: { kind: 'done', model: 'typesafe/jev', decidedAt: '2026-10-01T00:00:00.000Z', probability: 0.99 }, training: { kind: 'recorded', label: 'spam' } };
    const r = row(900, { revision: 1, queue: pendingQueue('backfill'), category: { decision: done(), action: { kind: 'skipped', reason: 'unmapped' } }, spam: spamDone }, { folder: 'Archive' });
    api.listQueuedMessages.mockResolvedValue([r]);
    await runTick({ mgr: mgr(), account });
    expect(Object.keys(api.jevDecide.mock.calls[0][0].questions)).toEqual(['category']);
    expect(patchFor(r.id).category.decision).toMatchObject({ kind: 'done', revision: 1 });
    expect(patchFor(r.id).spam).toEqual(spamDone);
    expect(api.recordJevSpamVerdict).not.toHaveBeenCalled();
  });
});
