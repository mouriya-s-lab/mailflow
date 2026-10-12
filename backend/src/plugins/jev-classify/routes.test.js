import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getOwnedAccount: vi.fn(),
  listUserAccounts: vi.fn(),
  isLabelStoreAccount: vi.fn(),
  isPluginActivated: vi.fn(),
  currentUidFloors: vi.fn(),
  countQueued: vi.fn(),
  listQueuedMessages: vi.fn(),
  listMessagesInQueueState: vi.fn(),
  setMessageAnnotation: vi.fn(),
  jevStatus: vi.fn(),
  reputationStatus: vi.fn(),
  storage: { getValue: vi.fn(), put: vi.fn() },
  getAccountConfig: vi.fn(),
  setAccountConfig: vi.fn(),
  logger: vi.fn(),
  markMessages: vi.fn(),
  getMessageSignals: vi.fn(),
  getMessageBodyTexts: vi.fn(),
  lookupDomainReputation: vi.fn(),
  jevDecide: vi.fn(),
  recordJevSpamVerdict: vi.fn(),
  requestSpamRetrain: vi.fn(),
  ensureSpamVerdict: vi.fn(),
  moveMessagesVerified: vi.fn(),
  applyLabel: vi.fn(),
  ensureLabelFolders: vi.fn(),
}));

// Keep the router, record parsers and processor real, without booting core services.
vi.mock('../api.js', () => mocks);

import express from 'express';
import router from './routes.js';

const PLUGIN = 'jev-classify';
const USER = 'router-test-user';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = { id: ACCOUNT_ID, user_id: USER, email_address: 'test@example.com' };
const ACCOUNT_PATH = `/accounts/${ACCOUNT_ID}`;
const DEFAULT_IDS = [
  'action-required', 'important-update', 'personal', 'money-and-orders',
  'newsletters', 'routine-notifications', 'cold-outreach', 'review',
];
const CATEGORIES = [
  { id: 'action-required', label: 'Action required', description: 'Needs a reply.' },
  { id: 'personal', label: 'Personal', description: 'From someone you know.' },
  { id: 'review', label: 'Review', description: 'Needs a closer look.' },
];
const SETTINGS = {
  enabled: true,
  classifyNewMail: false,
  routing: { 'action-required': 'Actions', personal: 'Personal' },
  createFolders: true,
  trainSpam: false,
  routingMinConfidence: 0.9,
};
const FLOORS = {
  Zebra: { uidValidity: 3, nextUid: 31 },
  INBOX: { uidValidity: 1, nextUid: 11 },
  Actions: { uidValidity: 2, nextUid: 21 },
};
const DECIDED_AT = '2026-10-12T00:00:00.000Z';
const CATEGORY_DONE = {
  kind: 'done', revision: 4, model: 'test-model', decidedAt: DECIDED_AT,
  choice: 'action-required', confidence: 0.95,
};
const ACTION_DONE = { kind: 'done', target: 'Actions', effect: 'moved' };
const SPAM_DONE = { kind: 'done', model: 'test-model', decidedAt: DECIDED_AT, probability: 0.99 };
const values = new Map();
const configs = new Map();
const storageKey = key => `${PLUGIN}:${key}`;
const configKey = id => `${PLUGIN}:${id}`;

function terminalRow(id, category, { origin = 'backfill', spam } = {}) {
  return {
    id,
    plugin_annotation: {
      revision: 4,
      queue: { state: 'terminal', dueAt: null, origin },
      category,
      ...(spam ? { spam } : {}),
    },
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    if (userId) req.session = { userId };
    next();
  });
  app.use('/api/jev-classify', router);
  return app;
}

let server;
let base;

async function request(path, { method = 'GET', user = USER, body } = {}) {
  const headers = {};
  if (user) headers['x-test-user'] = user;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}/api/jev-classify${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  await new Promise(resolve => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  vi.resetAllMocks();
  values.clear();
  configs.clear();
  mocks.requireAuth.mockImplementation((req, res, next) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
    next();
  });
  mocks.storage.getValue.mockImplementation(async (pluginId, key) =>
    structuredClone(values.get(`${pluginId}:${key}`) ?? null));
  mocks.storage.put.mockImplementation(async (pluginId, key, record) => {
    values.set(`${pluginId}:${key}`, structuredClone(record));
  });
  mocks.getAccountConfig.mockImplementation(async (pluginId, accountId) =>
    structuredClone(configs.get(`${pluginId}:${accountId}`) ?? {}));
  mocks.setAccountConfig.mockImplementation(async (pluginId, accountId, config) => {
    configs.set(`${pluginId}:${accountId}`, structuredClone(config));
  });
  mocks.getOwnedAccount.mockImplementation(async (userId, id) =>
    userId === USER && id === ACCOUNT_ID ? ACCOUNT : null);
  mocks.listUserAccounts.mockResolvedValue([ACCOUNT]);
  mocks.isLabelStoreAccount.mockReturnValue(false);
  mocks.isPluginActivated.mockResolvedValue(true);
  mocks.currentUidFloors.mockImplementation(async () => structuredClone(FLOORS));
  mocks.countQueued.mockResolvedValue({ pending: 0, retry: 0, terminal: 0, done: 0 });
  mocks.listQueuedMessages.mockResolvedValue([]);
  mocks.listMessagesInQueueState.mockResolvedValue([]);
  mocks.setMessageAnnotation.mockResolvedValue({ kind: 'written' });
  mocks.jevStatus.mockResolvedValue({ kind: 'unconfigured' });
  mocks.reputationStatus.mockResolvedValue({ kind: 'unconfigured' });
});

// Decisive observation: real HTTP responses and the capability Maps must agree. Only the
// API boundary is mocked; category validation, serialized writes and retry projection run real.
describe('Jev classification HTTP routes', () => {
  it('requires authentication for categories', async () => {
    expect(await request('/categories', { user: null })).toEqual({
      status: 401, body: { error: 'Not authenticated' },
    });
    expect(mocks.storage.getValue).not.toHaveBeenCalled();
    expect(mocks.storage.put).not.toHaveBeenCalled();
  });

  it('returns all eight defaults in order at revision zero without saving them', async () => {
    const response = await request('/categories');
    expect(response.status).toBe(200);
    expect(response.body.revision).toBe(0);
    expect(response.body.categories.map(category => category.id)).toEqual(DEFAULT_IDS);
    expect(mocks.storage.getValue).toHaveBeenCalledWith(PLUGIN, `user:${USER}:categories`);
    expect(mocks.storage.put).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });

  it.each([
    ['one category', CATEGORIES.slice(0, 1), 'categories'],
    ['25 categories', Array.from({ length: 25 }, (_, index) => ({
      id: `category-${index}`, label: `Category ${index}`, description: `Description ${index}`,
    })), 'categories'],
    ['whitespace label', CATEGORIES.map((category, index) =>
      index === 0 ? { ...category, label: ' \t ' } : category), 'categories[0].label'],
  ])('rejects %s without writing', async (_name, categories, field) => {
    const response = await request('/categories', { method: 'PUT', body: { categories } });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
    expect(response.body.fields[field]).toEqual(expect.any(String));
    expect(mocks.storage.put).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });

  it('persists three categories and increments the revision on every valid save', async () => {
    expect(await request('/categories', { method: 'PUT', body: { categories: CATEGORIES } })).toEqual({
      status: 200, body: { revision: 1 },
    });
    expect(values.get(storageKey(`user:${USER}:categories`))).toEqual({
      ownerId: USER, value: { revision: 1, categories: CATEGORIES },
    });
    const changed = CATEGORIES.map(category => ({ ...category, label: `${category.label} updated` }));
    expect(await request('/categories', { method: 'PUT', body: { categories: changed } })).toEqual({
      status: 200, body: { revision: 2 },
    });
    expect(await request('/categories')).toEqual({ status: 200, body: { revision: 2, categories: changed } });
    expect(mocks.storage.put).toHaveBeenCalledTimes(2);
    expect(values.get(storageKey(`user:${USER}:categories`))).toEqual({
      ownerId: USER, value: { revision: 2, categories: changed },
    });
  });

  it.each([
    ['INBOX target', { routing: { 'action-required': 'INBOX' } }, 'routing.action-required'],
    ['lowercase inbox target', { routing: { 'action-required': 'inbox' } }, 'routing.action-required'],
    ['string confidence', { routingMinConfidence: '0.9' }, 'routingMinConfidence'],
    ['unknown category', { routing: { unknown: 'Actions' } }, 'routing.unknown'],
    ['client-owned floors', { newMailFloors: FLOORS }, 'newMailFloors'],
  ])('rejects account settings with %s without writing', async (_name, patch, field) => {
    const response = await request(ACCOUNT_PATH, { method: 'PUT', body: { ...SETTINGS, ...patch } });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid request');
    expect(response.body.fields[field]).toEqual(expect.any(String));
    expect(mocks.getOwnedAccount).toHaveBeenCalledWith(USER, ACCOUNT_ID);
    expect(mocks.setAccountConfig).not.toHaveBeenCalled();
    expect(mocks.storage.put).not.toHaveBeenCalled();
    expect(configs.size).toBe(0);
  });

  it('rejects an account not owned by the session user without writing', async () => {
    mocks.getOwnedAccount.mockResolvedValue(null);
    expect(await request(ACCOUNT_PATH, { method: 'PUT', body: SETTINGS })).toEqual({
      status: 404, body: { error: 'Account not found' },
    });
    expect(mocks.getOwnedAccount).toHaveBeenCalledWith(USER, ACCOUNT_ID);
    expect(mocks.setAccountConfig).not.toHaveBeenCalled();
    expect(mocks.storage.put).not.toHaveBeenCalled();
    expect(configs.size).toBe(0);
  });

  it('rejects a non-UUID account id before ownership lookup or writes', async () => {
    const response = await request('/accounts/not-a-uuid', { method: 'PUT', body: SETTINGS });
    expect(response.status).toBe(400);
    expect(response.body.fields.id).toEqual(expect.any(String));
    expect(mocks.getOwnedAccount).not.toHaveBeenCalled();
    expect(mocks.setAccountConfig).not.toHaveBeenCalled();
    expect(mocks.storage.put).not.toHaveBeenCalled();
    expect(configs.size).toBe(0);
  });

  it('captures floors only when new-mail classification is enabled and clears them when disabled', async () => {
    const previousFloors = { INBOX: { uidValidity: 1, nextUid: 2 } };
    configs.set(configKey(ACCOUNT_ID), { ...SETTINGS, newMailFloors: previousFloors });
    mocks.isLabelStoreAccount.mockReturnValue(true);
    const enabled = { ...SETTINGS, classifyNewMail: true };
    expect(await request(ACCOUNT_PATH, { method: 'PUT', body: enabled })).toEqual({
      status: 200,
      body: {
        id: ACCOUNT_ID, emailAddress: ACCOUNT.email_address, config: enabled,
        newMailFloors: FLOORS, folders: ['Actions', 'INBOX', 'Zebra'], labelStore: true,
      },
    });
    expect(configs.get(configKey(ACCOUNT_ID))).toEqual({ ...enabled, newMailFloors: FLOORS });
    expect(mocks.setAccountConfig).toHaveBeenNthCalledWith(1, PLUGIN, ACCOUNT_ID, {
      ...enabled, newMailFloors: FLOORS,
    });
    expect(mocks.currentUidFloors).toHaveBeenCalledWith({ accountId: ACCOUNT_ID });
    expect(mocks.isLabelStoreAccount).toHaveBeenCalledWith(ACCOUNT);

    const laterFloors = {
      Zebra: { uidValidity: 3, nextUid: 99 },
      INBOX: { uidValidity: 1, nextUid: 100 },
      Archive: { uidValidity: 4, nextUid: 40 },
    };
    mocks.currentUidFloors.mockResolvedValue(laterFloors);
    const second = await request(ACCOUNT_PATH, { method: 'PUT', body: enabled });
    expect(second).toEqual({
      status: 200,
      body: {
        id: ACCOUNT_ID, emailAddress: ACCOUNT.email_address, config: enabled,
        newMailFloors: FLOORS, folders: ['Archive', 'INBOX', 'Zebra'], labelStore: true,
      },
    });
    expect(configs.get(configKey(ACCOUNT_ID))).toEqual({ ...enabled, newMailFloors: FLOORS });
    expect(mocks.setAccountConfig).toHaveBeenNthCalledWith(2, PLUGIN, ACCOUNT_ID, {
      ...enabled, newMailFloors: FLOORS,
    });

    const disabled = await request(ACCOUNT_PATH, { method: 'PUT', body: SETTINGS });
    expect(disabled.status).toBe(200);
    expect(disabled.body.config).toEqual(SETTINGS);
    expect(disabled.body.newMailFloors).toEqual({});
    expect(configs.get(configKey(ACCOUNT_ID))).toEqual({ ...SETTINGS, newMailFloors: {} });
    expect(mocks.setAccountConfig).toHaveBeenNthCalledWith(3, PLUGIN, ACCOUNT_ID, {
      ...SETTINGS, newMailFloors: {},
    });
  });

  it('re-queues switched-off spam lines only when trainSpam goes from off to on', async () => {
    const doneQueue = { state: 'done', dueAt: null, origin: 'backfill' };
    const off = { kind: 'skipped', reason: 'disabled' };
    mocks.listMessagesInQueueState.mockResolvedValue([{
      id: '22222222-2222-4222-8222-222222222222', folder: 'INBOX', uid: '1', message_id: '<m@mailflow-test.invalid>',
      plugin_annotation: { revision: CATEGORY_DONE.revision, queue: doneQueue, category: { decision: CATEGORY_DONE, action: ACTION_DONE }, spam: { decision: off, training: off } },
    }]);
    configs.set(configKey(ACCOUNT_ID), { ...SETTINGS, newMailFloors: {} });

    expect((await request(ACCOUNT_PATH, { method: 'PUT', body: SETTINGS })).status).toBe(200);
    await new Promise(resolve => setImmediate(resolve));
    expect(mocks.listMessagesInQueueState).not.toHaveBeenCalled();

    expect((await request(ACCOUNT_PATH, { method: 'PUT', body: { ...SETTINGS, trainSpam: true } })).status).toBe(200);
    await vi.waitFor(() => expect(mocks.setMessageAnnotation).toHaveBeenCalledTimes(1));
    expect(mocks.listMessagesInQueueState).toHaveBeenCalledWith({ accountId: ACCOUNT_ID, pluginId: PLUGIN, state: 'done', afterId: null, limit: 200 });
    expect(mocks.setMessageAnnotation).toHaveBeenCalledWith(ACCOUNT_ID, '22222222-2222-4222-8222-222222222222', PLUGIN, {
      queue: { state: 'pending', dueAt: null, origin: 'backfill' },
      category: { decision: CATEGORY_DONE, action: ACTION_DONE },
      spam: { decision: { kind: 'pending' }, training: { kind: 'blocked' } },
    });

    mocks.listMessagesInQueueState.mockClear();
    expect((await request(ACCOUNT_PATH, { method: 'PUT', body: { ...SETTINGS, trainSpam: true } })).status).toBe(200);
    await new Promise(resolve => setImmediate(resolve));
    expect(mocks.listMessagesInQueueState).not.toHaveBeenCalled();
  });

  it('starts and stops a revision-bound backfill without rewriting duplicate requests', async () => {
    values.set(storageKey(`user:${USER}:categories`), {
      ownerId: USER, value: { revision: 7, categories: CATEGORIES },
    });
    const started = await request(`${ACCOUNT_PATH}/backfill`, { method: 'POST' });
    expect(started.status).toBe(200);
    expect(started.body.backfill).toEqual({
      kind: 'running', revision: 7, marked: 0, processed: 0, failed: 0,
      startedAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(started.body.backfill.startedAt))).toBe(false);
    const key = storageKey(`account:${ACCOUNT_ID}:backfill`);
    expect(values.get(key)).toEqual({ ownerId: USER, value: started.body.backfill });
    expect(await request(`${ACCOUNT_PATH}/backfill`, { method: 'POST' })).toEqual({
      status: 409, body: { error: 'A backfill is already running', backfill: started.body.backfill },
    });
    expect(mocks.storage.put).toHaveBeenCalledTimes(1);
    expect(values.get(key).value).toEqual(started.body.backfill);

    const stopped = await request(`${ACCOUNT_PATH}/backfill`, { method: 'DELETE' });
    expect(stopped.status).toBe(200);
    expect(stopped.body.backfill).toEqual({
      ...started.body.backfill, kind: 'stopped', stoppedAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(stopped.body.backfill.stoppedAt))).toBe(false);
    expect(values.get(key)).toEqual({ ownerId: USER, value: stopped.body.backfill });
    expect(await request(`${ACCOUNT_PATH}/backfill`, { method: 'DELETE' })).toEqual({
      status: 409, body: { error: 'No backfill is running', backfill: stopped.body.backfill },
    });
    expect(mocks.storage.put).toHaveBeenCalledTimes(2);
    expect(values.get(key).value).toEqual(stopped.body.backfill);
  });

  it('reopens failed category decisions, actions and spam training while preserving queue origins', async () => {
    mocks.listMessagesInQueueState.mockResolvedValueOnce([
      terminalRow('decision-failed', {
        decision: { kind: 'terminal_failed', errorKind: 'invalid_response' },
        action: { kind: 'skipped', reason: 'decision_failed' },
      }),
      terminalRow('action-failed', {
        decision: CATEGORY_DONE,
        action: { kind: 'terminal_failed', target: 'X', outcome: 'folder_missing' },
      }, { origin: 'new_mail' }),
      terminalRow('training-failed', { decision: CATEGORY_DONE, action: ACTION_DONE }, {
        origin: 'new_mail',
        spam: { decision: SPAM_DONE, training: { kind: 'terminal_failed', label: 'spam' } },
      }),
    ]);
    expect(await request(`${ACCOUNT_PATH}/retry-failed`, { method: 'POST' })).toEqual({
      status: 200, body: { reset: 3 },
    });
    expect(mocks.setMessageAnnotation).toHaveBeenCalledTimes(3);
    expect(mocks.setMessageAnnotation).toHaveBeenNthCalledWith(1, ACCOUNT_ID, 'decision-failed', PLUGIN, {
      category: { decision: { kind: 'pending' }, action: { kind: 'blocked' } },
      queue: { state: 'pending', dueAt: null, origin: 'backfill' },
    });
    expect(mocks.setMessageAnnotation).toHaveBeenNthCalledWith(2, ACCOUNT_ID, 'action-failed', PLUGIN, {
      category: { decision: CATEGORY_DONE, action: { kind: 'pending' } },
      queue: { state: 'pending', dueAt: null, origin: 'new_mail' },
    });
    expect(mocks.setMessageAnnotation).toHaveBeenNthCalledWith(3, ACCOUNT_ID, 'training-failed', PLUGIN, {
      category: { decision: CATEGORY_DONE, action: ACTION_DONE },
      spam: { decision: SPAM_DONE, training: { kind: 'pending', label: 'spam' } },
      queue: { state: 'pending', dueAt: null, origin: 'new_mail' },
    });
    expect(mocks.listMessagesInQueueState).toHaveBeenCalledExactlyOnceWith({
      accountId: ACCOUNT_ID, pluginId: PLUGIN, state: 'terminal', afterId: null, limit: 200,
    });
  });

  it('requests and resets the next page after exactly 200 terminal rows', async () => {
    const failedCategory = {
      decision: { kind: 'terminal_failed', errorKind: 'invalid_response' },
      action: { kind: 'skipped', reason: 'decision_failed' },
    };
    const page = Array.from({ length: 200 }, (_, index) => terminalRow(`message-${index}`, failedCategory));
    mocks.listMessagesInQueueState.mockResolvedValueOnce(page)
      .mockResolvedValueOnce([terminalRow('next-page-message', failedCategory)]);
    expect(await request(`${ACCOUNT_PATH}/retry-failed`, { method: 'POST' })).toEqual({
      status: 200, body: { reset: 201 },
    });
    expect(mocks.listMessagesInQueueState).toHaveBeenCalledTimes(2);
    expect(mocks.listMessagesInQueueState).toHaveBeenNthCalledWith(1, {
      accountId: ACCOUNT_ID, pluginId: PLUGIN, state: 'terminal', afterId: null, limit: 200,
    });
    expect(mocks.listMessagesInQueueState).toHaveBeenNthCalledWith(2, {
      accountId: ACCOUNT_ID, pluginId: PLUGIN, state: 'terminal', afterId: page.at(-1).id, limit: 200,
    });
    expect(mocks.setMessageAnnotation).toHaveBeenCalledTimes(201);
    expect(mocks.setMessageAnnotation).toHaveBeenLastCalledWith(ACCOUNT_ID, 'next-page-message', PLUGIN, {
      category: { decision: { kind: 'pending' }, action: { kind: 'blocked' } },
      queue: { state: 'pending', dueAt: null, origin: 'backfill' },
    });
  });

  it('clears the stored incident list, not just the response', async () => {
    const key = `account:${ACCOUNT_ID}:incidents`;
    values.set(storageKey(key), {
      ownerId: USER,
      value: { incidents: [{ messageId: 'message-1', target: 'Actions', outcome: 'moved_unlocated', at: DECIDED_AT }] },
    });
    expect(await request(`${ACCOUNT_PATH}/incidents`, { method: 'DELETE' })).toEqual({
      status: 200, body: { incidents: [] },
    });
    expect(values.get(storageKey(key))).toEqual({ ownerId: USER, value: { incidents: [] } });
    expect(mocks.storage.put).toHaveBeenCalledExactlyOnceWith(PLUGIN, key, {
      ownerId: USER, value: { incidents: [] },
    });
  });

  it('passes through unconfigured Jev status and reports disabled accounts paused with summed terminal counts', async () => {
    configs.set(configKey(ACCOUNT_ID), { ...SETTINGS, enabled: false, newMailFloors: {} });
    const backfill = { pending: 1, retry: 2, terminal: 3, done: 4 };
    const newMail = { pending: 5, retry: 6, terminal: 7, done: 8 };
    mocks.countQueued.mockImplementation(async ({ origin }) => origin === 'backfill' ? backfill : newMail);
    const response = await request('/status');
    expect(response.status).toBe(200);
    expect(response.body.activated).toBe(true);
    expect(response.body.jev).toEqual({ kind: 'unconfigured' });
    expect(response.body.accounts).toEqual([{
      id: ACCOUNT_ID,
      emailAddress: ACCOUNT.email_address,
      state: 'paused',
      queue: { backfill, new_mail: newMail },
      nextDue: { kind: 'none' },
      terminalFailed: 10,
      backfill: { kind: 'idle' },
      lastDecidedAt: null,
      jevCalls: 0,
      incidents: [],
    }]);
    expect(mocks.countQueued).toHaveBeenCalledTimes(2);
    expect(mocks.countQueued).toHaveBeenCalledWith({ accountId: ACCOUNT_ID, pluginId: PLUGIN, origin: 'backfill' });
    expect(mocks.countQueued).toHaveBeenCalledWith({ accountId: ACCOUNT_ID, pluginId: PLUGIN, origin: 'new_mail' });
    expect(mocks.setAccountConfig).not.toHaveBeenCalled();
    expect(mocks.storage.put).not.toHaveBeenCalled();
  });
});
