import { beforeEach, describe, expect, it, vi } from 'vitest';

const sources = vi.hoisted(() => ({
  listUserAccounts: vi.fn(),
  getActivatedPlugins: vi.fn(),
  listPlugins: vi.fn(),
}));
vi.mock('../../src/services/mailAccess.js', () => ({ listUserAccounts: sources.listUserAccounts }));
vi.mock('../../src/plugins/activation.js', () => ({ getActivatedPlugins: sources.getActivatedPlugins }));
vi.mock('../../src/plugins/registry.js', () => ({ pluginRegistry: { list: sources.listPlugins } }));

import { inspectBackfills, startBackfills } from './index.js';

const userId = 'user-one';
const accounts = [
  { id: 'account-one', email_address: 'one@example.com', enabled: true },
  { id: 'account-two', email_address: 'two@example.com', enabled: true },
  { id: 'account-disabled', email_address: 'disabled@example.com', enabled: false },
];
const idle = { kind: 'idle' };
const running = {
  kind: 'running', revision: 7,
  startedAt: '2026-10-16T10:00:00.000Z', completedAt: null, stoppedAt: null,
  marked: 23, processed: 11, failed: 2,
};
const available = (backfill = idle, eligibility = { kind: 'ready' }) => ({
  kind: 'available', eligibility, backfill,
});
const capability = () => ({
  inspect: vi.fn(async () => available()),
  start: vi.fn(async () => ({ kind: 'started', backfill: running })),
});
const plugin = (id, backfill) => ({ id, name: `Plugin ${id}`, ...(backfill ? { backfill } : {}) });
const resultFor = (manifest, account, outcome) => ({
  pluginId: manifest.id,
  pluginName: manifest.name,
  accountId: account.id,
  emailAddress: account.email_address,
  outcome,
});

beforeEach(() => {
  vi.resetAllMocks();
  sources.listUserAccounts.mockResolvedValue(accounts);
  sources.getActivatedPlugins.mockResolvedValue(new Set());
  sources.listPlugins.mockReturnValue([]);
});

describe('plugin backfill inspection', () => {
  it('lists every plugin and inspects owned accounts even when a supported plugin is inactive', async () => {
    const active = plugin('active', capability());
    const inactive = plugin('inactive', capability());
    const unsupported = plugin('unsupported');
    const inactiveUnsupported = plugin('inactive-unsupported');
    const disabledStatus = available(running, { kind: 'skipped', reason: 'account_disabled' });
    const inactiveStatus = available(running, { kind: 'skipped', reason: 'plugin_inactive' });
    active.backfill.inspect.mockImplementation(async (_userId, accountId) => (
      accountId === accounts[2].id ? disabledStatus : available(running)
    ));
    inactive.backfill.inspect.mockResolvedValue(inactiveStatus);
    sources.listPlugins.mockReturnValue([active, inactive, unsupported, inactiveUnsupported]);
    sources.getActivatedPlugins.mockResolvedValue(new Set([active.id, unsupported.id]));

    const response = await inspectBackfills(userId);

    expect(response.plugins).toHaveLength(4);
    expect(response.plugins).toEqual(expect.arrayContaining([
      {
        id: active.id, name: active.name, activated: true, supported: true,
        accounts: accounts.map(account => ({
          id: account.id, emailAddress: account.email_address,
          status: account.enabled ? available(running) : disabledStatus,
        })),
      },
      {
        id: inactive.id, name: inactive.name, activated: false, supported: true,
        accounts: accounts.map(account => ({ id: account.id, emailAddress: account.email_address, status: inactiveStatus })),
      },
      { id: unsupported.id, name: unsupported.name, activated: true, supported: false, accounts: [] },
      { id: inactiveUnsupported.id, name: inactiveUnsupported.name, activated: false, supported: false, accounts: [] },
    ]));
    for (const manifest of [active, inactive]) {
      expect(manifest.backfill.inspect).toHaveBeenCalledTimes(accounts.length);
      for (const account of accounts) expect(manifest.backfill.inspect).toHaveBeenCalledWith(userId, account.id);
      expect(manifest.backfill.start).not.toHaveBeenCalled();
    }
    expect(sources.listUserAccounts).toHaveBeenCalledWith(userId);
    expect(sources.getActivatedPlugins).toHaveBeenCalledWith(userId, { fresh: true });
  });

  it('keeps each failed inspection visible without dropping healthy accounts or plugins', async () => {
    const broken = plugin('broken', capability());
    const healthy = plugin('healthy', capability());
    broken.backfill.inspect.mockImplementation((_userId, accountId) => {
      if (accountId === accounts[0].id) throw new Error('synchronous status failure');
      if (accountId === accounts[1].id) return Promise.reject(new Error('asynchronous status failure'));
      return Promise.resolve(available(running));
    });
    sources.listPlugins.mockReturnValue([broken, healthy]);
    sources.getActivatedPlugins.mockResolvedValue(new Set([broken.id, healthy.id]));

    const { plugins } = await inspectBackfills(userId);

    expect(plugins).toHaveLength(2);
    expect(plugins.find(entry => entry.id === broken.id).accounts).toEqual([
      { id: accounts[0].id, emailAddress: accounts[0].email_address, status: { kind: 'failed', error: 'status_failed' } },
      { id: accounts[1].id, emailAddress: accounts[1].email_address, status: { kind: 'failed', error: 'status_failed' } },
      { id: accounts[2].id, emailAddress: accounts[2].email_address, status: available(running) },
    ]);
    expect(plugins.find(entry => entry.id === healthy.id).accounts).toEqual(accounts.map(account => ({
      id: account.id, emailAddress: account.email_address, status: available(),
    })));
  });
});

describe('plugin backfill submission', () => {
  it('returns the entire owned-account by active-supported-plugin matrix and preserves owner outcomes', async () => {
    const first = plugin('first', capability());
    const second = plugin('second', capability());
    const inactive = plugin('inactive', capability());
    const unsupported = plugin('unsupported');
    const noCapability = plugin('inactive-unsupported');
    const firstOutcomes = [
      { kind: 'started', backfill: running },
      { kind: 'already_running', backfill: running },
      { kind: 'skipped', reason: 'account_disabled' },
    ];
    const secondOutcomes = [
      { kind: 'skipped', reason: 'module_disabled' },
      { kind: 'skipped', reason: 'service_unconfigured' },
      { kind: 'skipped', reason: 'account_disabled' },
    ];
    first.backfill.start.mockImplementation(async (_userId, accountId) => firstOutcomes[accounts.findIndex(account => account.id === accountId)]);
    second.backfill.start.mockImplementation(async (_userId, accountId) => secondOutcomes[accounts.findIndex(account => account.id === accountId)]);
    sources.listPlugins.mockReturnValue([first, second, inactive, unsupported, noCapability]);
    sources.getActivatedPlugins.mockResolvedValue(new Set([first.id, second.id, unsupported.id, 'not-installed']));

    const { results } = await startBackfills(userId);

    expect(results).toHaveLength(accounts.length * 2);
    expect(results).toEqual(expect.arrayContaining([
      ...accounts.map((account, index) => resultFor(first, account, firstOutcomes[index])),
      ...accounts.map((account, index) => resultFor(second, account, secondOutcomes[index])),
    ]));
    for (const manifest of [first, second]) {
      expect(manifest.backfill.start).toHaveBeenCalledTimes(accounts.length);
      for (const account of accounts) expect(manifest.backfill.start).toHaveBeenCalledWith(userId, account.id);
      expect(manifest.backfill.inspect).not.toHaveBeenCalled();
    }
    expect(inactive.backfill.start).not.toHaveBeenCalled();
    expect(inactive.backfill.inspect).not.toHaveBeenCalled();
    expect(sources.listUserAccounts).toHaveBeenCalledWith(userId);
    expect(sources.getActivatedPlugins).toHaveBeenCalledWith(userId, { fresh: true });
  });

  it('returns a result for every target when individual owners throw or reject', async () => {
    const broken = plugin('broken', capability());
    const healthy = plugin('healthy', capability());
    broken.backfill.start.mockImplementation((_userId, accountId) => {
      if (accountId === accounts[0].id) throw new Error('synchronous start failure');
      if (accountId === accounts[1].id) return Promise.reject(new Error('asynchronous start failure'));
      return Promise.resolve({ kind: 'skipped', reason: 'service_disabled' });
    });
    sources.listPlugins.mockReturnValue([broken, healthy]);
    sources.getActivatedPlugins.mockResolvedValue(new Set([broken.id, healthy.id]));

    const { results } = await startBackfills(userId);

    expect(results).toHaveLength(accounts.length * 2);
    expect(results).toEqual(expect.arrayContaining([
      resultFor(broken, accounts[0], { kind: 'failed', error: 'start_failed' }),
      resultFor(broken, accounts[1], { kind: 'failed', error: 'start_failed' }),
      resultFor(broken, accounts[2], { kind: 'skipped', reason: 'service_disabled' }),
      ...accounts.map(account => resultFor(healthy, account, { kind: 'started', backfill: running })),
    ]));
    expect(healthy.backfill.start).toHaveBeenCalledTimes(accounts.length);
  });

  it('preserves the owner started and already-running outcomes across concurrent submissions', async () => {
    const owner = capability();
    const manifest = plugin('single', owner);
    let enterFirst;
    let releaseFirst;
    const firstEntered = new Promise(resolve => { enterFirst = resolve; });
    const firstOutcome = new Promise(resolve => { releaseFirst = resolve; });
    owner.start.mockImplementationOnce(() => { enterFirst(); return firstOutcome; });
    owner.start.mockResolvedValue({ kind: 'already_running', backfill: running });
    sources.listUserAccounts.mockResolvedValue([accounts[0]]);
    sources.listPlugins.mockReturnValue([manifest]);
    sources.getActivatedPlugins.mockResolvedValue(new Set([manifest.id]));

    const firstRequest = startBackfills(userId);
    await firstEntered;
    let secondResponse;
    try {
      secondResponse = await startBackfills(userId);
    } finally {
      releaseFirst({ kind: 'started', backfill: running });
    }
    const responses = [await firstRequest, secondResponse];

    expect(responses).toEqual(expect.arrayContaining([
      { results: [resultFor(manifest, accounts[0], { kind: 'started', backfill: running })] },
      { results: [resultFor(manifest, accounts[0], { kind: 'already_running', backfill: running })] },
    ]));
    expect(owner.start).toHaveBeenCalledTimes(2);
  });

  it('returns an empty submission when no plugin is activated', async () => {
    const manifest = plugin('inactive', capability());
    sources.listPlugins.mockReturnValue([manifest]);

    expect(await startBackfills(userId)).toEqual({ results: [] });
    expect(manifest.backfill.start).not.toHaveBeenCalled();
  });

  it('does not invent targets when the user has no accounts', async () => {
    const manifest = plugin('active', capability());
    sources.listUserAccounts.mockResolvedValue([]);
    sources.listPlugins.mockReturnValue([manifest]);
    sources.getActivatedPlugins.mockResolvedValue(new Set([manifest.id]));

    expect(await startBackfills(userId)).toEqual({ results: [] });
    expect((await inspectBackfills(userId)).plugins).toEqual([
      { id: manifest.id, name: manifest.name, activated: true, supported: true, accounts: [] },
    ]);
    expect(manifest.backfill.start).not.toHaveBeenCalled();
    expect(manifest.backfill.inspect).not.toHaveBeenCalled();
  });
});

describe.each([
  ['inspection', inspectBackfills],
  ['submission', startBackfills],
])('plugin backfill %s source failures', (_name, request) => {
  it.each(['accounts', 'activation', 'registry'])('propagates %s authority failure instead of returning an empty success', async (source) => {
    const failure = new Error(`${source} unavailable`);
    const manifest = plugin('active', capability());
    sources.listPlugins.mockReturnValue([manifest]);
    sources.getActivatedPlugins.mockResolvedValue(new Set([manifest.id]));
    if (source === 'accounts') sources.listUserAccounts.mockRejectedValue(failure);
    if (source === 'activation') sources.getActivatedPlugins.mockRejectedValue(failure);
    if (source === 'registry') sources.listPlugins.mockImplementation(() => { throw failure; });

    await expect(request(userId)).rejects.toThrow();
  });
});
