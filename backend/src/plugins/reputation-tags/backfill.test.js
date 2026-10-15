import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const account = vi.hoisted(() => ({
  id: '00000000-0000-4000-8000-000000000044', user_id: 'user', enabled: true, protocol: 'imap',
}));
const state = vi.hoisted(() => ({ backfill: null, rows: [], bodyAvailable: false }));
const api = vi.hoisted(() => ({
  NEW_DOMAIN_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
  logger: { warn: vi.fn() },
  requireAuth: (req, _res, next) => { req.session = { userId: account.user_id }; next(); },
  getOwnedAccount: vi.fn(async () => account), listUserAccounts: vi.fn(async () => [account]),
  isPluginActivated: vi.fn(async () => true), isPluginActivatedForAccount: vi.fn(async () => true),
  sourceStatus: vi.fn(async () => 'enabled'),
  getAccountConfig: vi.fn(async () => ({ newMailFloors: { INBOX: { uidValidity: 1, nextUid: 62 } } })),
  setAccountConfig: vi.fn(), currentUidFloors: vi.fn(async () => ({ INBOX: { uidValidity: 1, nextUid: 62 } })),
  storage: {
    getValue: vi.fn(async () => state.backfill),
    put: vi.fn(async (_pluginId, _key, { value, ownerId }) => { state.backfill = { value, owner_id: ownerId }; }),
  },
  markMessages: vi.fn(async ({ scope, limit }) => {
    if (scope.kind === 'above_uid_floor') return 0;
    const batch = state.rows.filter(row => !row.plugin_annotation).slice(0, limit);
    for (const row of batch) row.plugin_annotation = { revision: 0, queue: { state: 'pending', origin: 'backfill', dueAt: null } };
    return batch.length;
  }),
  listQueuedMessages: vi.fn(async () => state.rows.filter(row => row.plugin_annotation?.queue.state === 'pending')),
  countQueued: vi.fn(async ({ origin }) => {
    const counts = { pending: 0, retry: 0, done: 0, terminal: 0 };
    for (const row of state.rows) if (row.plugin_annotation?.queue.origin === origin) counts[row.plugin_annotation.queue.state]++;
    return counts;
  }),
  ensureMessageBodies: vi.fn(async (_id, ids) => new Map(ids.map(id => [id, state.bodyAvailable
    ? { kind: 'stored' } : { kind: 'unavailable', reason: 'imap_error' }]))),
  getMessageLinks: vi.fn(async (_id, ids) => new Map(ids.map(id => [id, []]))),
  getMessageAnnotations: vi.fn(), reputationUrlSubject: vi.fn(),
  setMessageAnnotation: vi.fn(async (_accountId, id, _pluginId, patch) => {
    state.rows.find(row => row.id === id).plugin_annotation = patch;
    return { kind: 'written' };
  }),
}));
vi.mock('../api.js', () => api);
import { runTick } from './processor.js';
import { createRoutes } from './routes.js';
import { startBackfill } from './backfill.js';
import { REVISION } from './model.js';

const plugin = { id: 'tag-rdap', source: 'rdap', lookup: vi.fn(async () => new Map()) };
let server;
beforeEach(() => {
  state.backfill = null; state.bodyAvailable = false;
  state.rows = Array.from({ length: 61 }, (_, index) => ({ id: `history-${index + 1}` }));
  vi.clearAllMocks();
  account.enabled = true; account.protocol = 'imap';
  api.getOwnedAccount.mockImplementation(async (userId, accountId) =>
    userId === account.user_id && accountId === account.id ? account : null);
  api.isPluginActivated.mockResolvedValue(true);
  api.sourceStatus.mockResolvedValue('enabled');
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});

const previousRun = () => ({
  kind: 'stopped', revision: REVISION, startedAt: '2026-10-01T00:00:00.000Z',
  marked: 37, processed: 19, failed: 2, stoppedAt: '2026-10-01T00:01:00.000Z',
});

describe('backfill owner start boundary', () => {
  it.each([
    ['no previous run', null],
    ['a stopped run', previousRun()],
    ['a completed run', {
      kind: 'completed', revision: REVISION, startedAt: '2026-10-01T00:00:00.000Z',
      marked: 37, processed: 37, failed: 2, finishedAt: '2026-10-01T00:01:00.000Z',
    }],
  ])('starts an eligible account with %s', async (_label, previous) => {
    state.backfill = previous ? { value: previous, owner_id: account.user_id } : null;

    const outcome = await startBackfill(plugin, account.user_id, account.id);

    expect(outcome).toEqual({
      kind: 'started',
      backfill: {
        kind: 'running', revision: REVISION, startedAt: expect.any(String),
        marked: 0, processed: 0, failed: 0,
      },
    });
    expect(Number.isNaN(Date.parse(outcome.backfill.startedAt))).toBe(false);
    expect(api.getOwnedAccount).toHaveBeenCalledWith(account.user_id, account.id);
    expect(api.isPluginActivated).toHaveBeenCalledWith(account.user_id, plugin.id, { fresh: true });
    expect(api.sourceStatus).toHaveBeenCalledWith(plugin.source);
    expect(api.storage.put).toHaveBeenCalledExactlyOnceWith(
      plugin.id, `account:${account.id}:backfill`, { value: outcome.backfill, ownerId: account.user_id },
    );
    expect(state.backfill).toEqual({ value: outcome.backfill, owner_id: account.user_id });
  });

  it.each([
    ['a disabled account', false, 'imap', true, 'enabled', 'account_disabled'],
    ['a non-IMAP account', true, 'pop3', true, 'enabled', 'unsupported_protocol'],
    ['an account without a protocol', true, undefined, true, 'enabled', 'unsupported_protocol'],
    ['an inactive plugin', true, 'imap', false, 'enabled', 'plugin_inactive'],
    ['a disabled source', true, 'imap', true, 'disabled', 'service_disabled'],
    ['an unconfigured source', true, 'imap', true, 'unconfigured', 'service_unconfigured'],
  ])('does not write for %s', async (_label, enabled, protocol, activated, source, reason) => {
    account.enabled = enabled; account.protocol = protocol;
    api.isPluginActivated.mockResolvedValue(activated);
    api.sourceStatus.mockResolvedValue(source);
    const stored = { value: previousRun(), owner_id: account.user_id };
    state.backfill = structuredClone(stored);

    expect(await startBackfill(plugin, account.user_id, account.id)).toEqual({ kind: 'skipped', reason });

    expect(api.storage.put).not.toHaveBeenCalled();
    expect(state.backfill).toEqual(stored);
  });

  it.each([
    ['another user', 'other-user', account.id],
    ['a missing account', account.user_id, '00000000-0000-4000-8000-000000000099'],
  ])('does not read or write private records for %s', async (_label, userId, accountId) => {
    const stored = { value: previousRun(), owner_id: account.user_id };
    state.backfill = structuredClone(stored);

    expect(await startBackfill(plugin, userId, accountId)).toEqual({
      kind: 'skipped', reason: 'account_missing',
    });

    expect(api.getOwnedAccount).toHaveBeenCalledWith(userId, accountId);
    expect(api.storage.getValue).not.toHaveBeenCalled();
    expect(api.storage.put).not.toHaveBeenCalled();
    expect(api.isPluginActivated).not.toHaveBeenCalled();
    expect(api.sourceStatus).not.toHaveBeenCalled();
    expect(state.backfill).toEqual(stored);
  });

  it('preserves a running record without rechecking eligibility or resetting progress', async () => {
    const running = {
      kind: 'running', revision: REVISION, startedAt: '2026-10-01T00:00:00.000Z',
      marked: 37, processed: 19, failed: 2,
    };
    const stored = { value: running, owner_id: account.user_id };
    state.backfill = structuredClone(stored);
    account.enabled = false; account.protocol = 'pop3';
    api.isPluginActivated.mockResolvedValue(false);
    api.sourceStatus.mockResolvedValue('unconfigured');

    expect(await startBackfill(plugin, account.user_id, account.id)).toEqual({
      kind: 'already_running', backfill: running,
    });

    expect(api.storage.put).not.toHaveBeenCalled();
    expect(api.isPluginActivated).not.toHaveBeenCalled();
    expect(api.sourceStatus).not.toHaveBeenCalled();
    expect(state.backfill).toEqual(stored);
  });

  it('serializes concurrent starts into one new run', async () => {
    const outcomes = await Promise.all(Array.from({ length: 3 }, () =>
      startBackfill(plugin, account.user_id, account.id)));
    const started = outcomes.filter(outcome => outcome.kind === 'started');
    const alreadyRunning = outcomes.filter(outcome => outcome.kind === 'already_running');

    expect(started).toHaveLength(1);
    expect(alreadyRunning).toHaveLength(2);
    expect(alreadyRunning.map(outcome => outcome.backfill)).toEqual([
      started[0].backfill, started[0].backfill,
    ]);
    expect(api.storage.put).toHaveBeenCalledExactlyOnceWith(
      plugin.id, `account:${account.id}:backfill`, { value: started[0].backfill, ownerId: account.user_id },
    );
    expect(state.backfill).toEqual({ value: started[0].backfill, owner_id: account.user_id });
  });
});

describe('stopped backfill progress', () => {
  it('counts queued rows completed after stop without marking another batch or changing stopped state', async () => {
    const app = express(); app.use('/api/tag-rdap', createRoutes(plugin));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/tag-rdap`;
    const request = async (path, method = 'GET') => {
      const response = await fetch(base + path, { method });
      expect(response.status).toBe(200);
      return response.json();
    };
    const status = async () => (await request('/status')).accounts[0];
    const context = { account, mgr: { isConnected: () => true } };
    await request(`/accounts/${account.id}/backfill`, 'POST');
    await runTick(plugin, context);
    expect((await status()).backfill).toMatchObject({ kind: 'running', marked: 50, processed: 0 });
    expect((await status()).queue.backfill.pending).toBe(50);
    expect(state.rows.every(row => !row.plugin_annotation?.result)).toBe(true);

    const stopped = (await request(`/accounts/${account.id}/backfill`, 'DELETE')).backfill;
    state.bodyAvailable = true;
    await runTick(plugin, context);
    await runTick(plugin, context);
    const drained = await status();
    expect(state.rows.filter(row => row.plugin_annotation?.result?.kind === 'complete')).toHaveLength(50);
    expect(state.rows.filter(row => !row.plugin_annotation)).toHaveLength(11);
    expect(drained.queue.backfill).toEqual({ pending: 0, retry: 0, done: 50, terminal: 0 });
    expect(drained.backfill).toEqual({ ...stopped, processed: 50 });
    expect(api.logger.warn).not.toHaveBeenCalled();
  });
});
