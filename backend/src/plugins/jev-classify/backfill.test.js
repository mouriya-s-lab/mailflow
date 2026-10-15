import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOwnedAccount: vi.fn(),
  isPluginActivated: vi.fn(),
  jevStatus: vi.fn(),
  storage: { getValue: vi.fn(), put: vi.fn() },
  getAccountConfig: vi.fn(),
  setAccountConfig: vi.fn(),
}));

vi.mock('../api.js', () => mocks);

import { inspectBackfill, startBackfill } from './backfill.js';
import { loadBackfill } from './records.js';

const PLUGIN = 'jev-classify';
const USER = 'backfill-owner';
const OTHER_USER = 'another-user';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = { id: ACCOUNT_ID, user_id: USER, enabled: true, protocol: 'imap' };
const BACKFILL_KEY = `account:${ACCOUNT_ID}:backfill`;
const CONFIG = {
  enabled: true,
  classifyNewMail: false,
  newMailFloors: {},
  routing: {},
  createFolders: false,
  trainSpam: false,
  routingMinConfidence: 0.9,
};
const CATEGORIES = {
  revision: 7,
  categories: [
    { id: 'personal', label: 'Personal', description: 'People you know.' },
    { id: 'review', label: 'Review', description: 'Needs a closer look.' },
  ],
};
const RUNNING = {
  kind: 'running', revision: 4, startedAt: '2026-10-12T00:00:00.000Z',
  marked: 41, processed: 23, failed: 2,
};
const values = new Map();
const storageKey = key => `${PLUGIN}:${key}`;

const unavailable = [
  ['disabled account', 'account_disabled', () => {
    mocks.getOwnedAccount.mockResolvedValue({ ...ACCOUNT, enabled: false });
  }],
  ['non-IMAP account', 'unsupported_protocol', () => {
    mocks.getOwnedAccount.mockResolvedValue({ ...ACCOUNT, protocol: 'pop3' });
  }],
  ['inactive plugin', 'plugin_inactive', () => {
    mocks.isPluginActivated.mockResolvedValue(false);
  }],
  ['disabled account module', 'module_disabled', () => {
    mocks.getAccountConfig.mockResolvedValue({ ...CONFIG, enabled: false });
  }],
  ['unconfigured Jev service', 'service_unconfigured', () => {
    mocks.jevStatus.mockResolvedValue({ kind: 'unconfigured' });
  }],
];

beforeEach(() => {
  vi.resetAllMocks();
  values.clear();
  values.set(storageKey(`user:${USER}:categories`), { ownerId: USER, value: CATEGORIES });
  mocks.getOwnedAccount.mockImplementation(async (userId, accountId) =>
    userId === USER && accountId === ACCOUNT_ID ? ACCOUNT : null);
  mocks.isPluginActivated.mockResolvedValue(true);
  mocks.jevStatus.mockResolvedValue({ kind: 'configured' });
  mocks.getAccountConfig.mockResolvedValue(CONFIG);
  mocks.storage.getValue.mockImplementation(async (pluginId, key) =>
    structuredClone(values.get(`${pluginId}:${key}`) ?? null));
  mocks.storage.put.mockImplementation(async (pluginId, key, record) => {
    values.set(`${pluginId}:${key}`, structuredClone(record));
  });
});

describe('Jev backfill owner', () => {
  it('starts an eligible account at the current category revision and persists its owner', async () => {
    const outcome = await startBackfill(USER, ACCOUNT_ID);
    expect(outcome).toEqual({
      kind: 'started',
      backfill: {
        kind: 'running', revision: 7, startedAt: expect.any(String),
        marked: 0, processed: 0, failed: 0,
      },
    });
    expect(Number.isNaN(Date.parse(outcome.backfill.startedAt))).toBe(false);
    expect(mocks.isPluginActivated).toHaveBeenCalledWith(USER, PLUGIN, { fresh: true });
    expect(mocks.getAccountConfig).toHaveBeenCalledWith(PLUGIN, ACCOUNT_ID);
    expect(mocks.storage.put).toHaveBeenCalledExactlyOnceWith(PLUGIN, BACKFILL_KEY, {
      ownerId: USER, value: outcome.backfill,
    });
    expect(await loadBackfill(ACCOUNT_ID)).toEqual(outcome.backfill);
  });

  it.each(unavailable)('does not leave an idle %s permanently running', async (_name, reason, arrange) => {
    arrange();
    const before = structuredClone(values);
    expect(await startBackfill(USER, ACCOUNT_ID)).toEqual({ kind: 'skipped', reason });
    expect(await loadBackfill(ACCOUNT_ID)).toEqual({ kind: 'idle' });
    expect(values).toEqual(before);
    expect(mocks.storage.put).not.toHaveBeenCalled();
    expect(mocks.setAccountConfig).not.toHaveBeenCalled();
  });

  it.each(unavailable)('preserves a stopped run when restarting a %s is refused', async (_name, reason, arrange) => {
    const stopped = { ...RUNNING, kind: 'stopped', stoppedAt: '2026-10-13T00:00:00.000Z' };
    values.set(storageKey(BACKFILL_KEY), { ownerId: USER, value: stopped });
    arrange();
    expect(await startBackfill(USER, ACCOUNT_ID)).toEqual({ kind: 'skipped', reason });
    expect(await loadBackfill(ACCOUNT_ID)).toEqual(stopped);
    expect(values.get(storageKey(BACKFILL_KEY))).toEqual({ ownerId: USER, value: stopped });
    expect(mocks.storage.put).not.toHaveBeenCalled();
  });

  it('rejects another user before reading private configuration or existing progress', async () => {
    values.set(storageKey(BACKFILL_KEY), { ownerId: USER, value: RUNNING });
    const before = structuredClone(values);
    expect(await startBackfill(OTHER_USER, ACCOUNT_ID)).toEqual({ kind: 'skipped', reason: 'account_missing' });
    expect(await inspectBackfill(OTHER_USER, ACCOUNT_ID)).toEqual({
      kind: 'available', eligibility: { kind: 'skipped', reason: 'account_missing' }, backfill: { kind: 'idle' },
    });
    expect(mocks.getOwnedAccount).toHaveBeenCalledWith(OTHER_USER, ACCOUNT_ID);
    expect(mocks.storage.getValue).not.toHaveBeenCalled();
    expect(mocks.getAccountConfig).not.toHaveBeenCalled();
    expect(mocks.isPluginActivated).not.toHaveBeenCalled();
    expect(mocks.jevStatus).not.toHaveBeenCalled();
    expect(mocks.storage.put).not.toHaveBeenCalled();
    expect(values).toEqual(before);
  });

  it.each(unavailable)('preserves running progress when duplicate start finds a %s', async (_name, _reason, arrange) => {
    values.set(storageKey(BACKFILL_KEY), { ownerId: USER, value: RUNNING });
    arrange();
    expect(await startBackfill(USER, ACCOUNT_ID)).toEqual({ kind: 'already_running', backfill: RUNNING });
    expect(await loadBackfill(ACCOUNT_ID)).toEqual(RUNNING);
    expect(values.get(storageKey(BACKFILL_KEY))).toEqual({ ownerId: USER, value: RUNNING });
    expect(mocks.storage.put).not.toHaveBeenCalled();
  });

  it('serializes overlapping same-account starts into exactly one persisted run', async () => {
    let releaseWrite;
    let enteredWrite;
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const writeEntered = new Promise(resolve => { enteredWrite = resolve; });
    mocks.storage.put.mockImplementation(async (pluginId, key, record) => {
      enteredWrite();
      await writeGate;
      values.set(`${pluginId}:${key}`, structuredClone(record));
    });

    const first = startBackfill(USER, ACCOUNT_ID);
    await writeEntered;
    let secondSettled = false;
    const second = startBackfill(USER, ACCOUNT_ID).then(result => {
      secondSettled = true;
      return result;
    });
    // Drain ready work while the first write is held, so the second call must contend.
    await new Promise(resolve => setImmediate(resolve));
    const writesWhileHeld = mocks.storage.put.mock.calls.length;
    const settledWhileHeld = secondSettled;
    releaseWrite();
    const [started, duplicate] = await Promise.all([first, second]);

    expect(writesWhileHeld).toBe(1);
    expect(settledWhileHeld).toBe(false);
    expect(started.kind).toBe('started');
    expect(duplicate).toEqual({ kind: 'already_running', backfill: started.backfill });
    expect(mocks.storage.put).toHaveBeenCalledTimes(1);
    expect(values.get(storageKey(BACKFILL_KEY))).toEqual({ ownerId: USER, value: started.backfill });
    expect(await loadBackfill(ACCOUNT_ID)).toEqual(started.backfill);
  });
});
