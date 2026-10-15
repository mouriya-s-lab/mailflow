import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const account = vi.hoisted(() => ({ id: '00000000-0000-4000-8000-000000000044', user_id: 'user' }));
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

const plugin = { id: 'tag-rdap', source: 'rdap', lookup: vi.fn(async () => new Map()) };
let server;
beforeEach(() => {
  state.backfill = null; state.bodyAvailable = false;
  state.rows = Array.from({ length: 61 }, (_, index) => ({ id: `history-${index + 1}` }));
  vi.clearAllMocks();
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
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
