import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  activated: false,
  status: 'enabled',
  isPluginActivated: vi.fn(), sourceStatus: vi.fn(),
  getAccountConfig: vi.fn(async () => ({})), setAccountConfig: vi.fn(), currentUidFloors: vi.fn(async () => ({})),
  markMessages: vi.fn(async () => 0), listQueuedMessages: vi.fn(async () => []), countQueued: vi.fn(),
  storage: { getValue: vi.fn(async () => null), put: vi.fn() },
  logger: { warn: vi.fn() },
}));
vi.mock('../api.js', () => ({ ...api, requireAuth: (_req,_res,next) => next(),
  NEW_DOMAIN_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
  getOwnedAccount: vi.fn(), listUserAccounts: vi.fn(), isPluginActivatedForAccount: vi.fn(),
  getMessageAnnotations: vi.fn(), setMessageAnnotation: vi.fn(), ensureMessageBodies: vi.fn(), getMessageLinks: vi.fn(), reputationUrlSubject: vi.fn(),
  lookupRdap: vi.fn(), lookupSpamhausDbl: vi.fn(), lookupUrlhaus: vi.fn(), lookupSafeBrowsing: vi.fn(),
}));
import { createPluginRegistry } from '../registry.js';
import { reputationTagPlugins } from './index.js';

beforeEach(() => {
  api.activated = false; api.status = 'enabled';
  api.isPluginActivated.mockImplementation(async () => api.activated);
  api.sourceStatus.mockImplementation(async () => api.status);
  api.logger.warn.mockClear();
});

describe('reputation hook activation and sibling fanout', () => {
  it('registration alone does not enable read/star sibling fanout; an activated configured tick does', async () => {
    const registry = createPluginRegistry();
    for (const plugin of reputationTagPlugins) registry.register(plugin);
    const account = { id: 'fanout-test', user_id: 'user' }, mgr = { isConnected: () => true };
    // Exactly the predicate accountMaintainsLabelSiblings in routes/mail.js uses.
    const maintainsSiblings = () => registry.hasActiveAsync('inboxIngest', { account: { id: account.id } });
    expect(await maintainsSiblings()).toBe(false);
    await Promise.all(reputationTagPlugins.map(plugin => plugin.sync.tick({ mgr, account })));
    expect(await maintainsSiblings()).toBe(false);
    api.activated = true;
    await Promise.all(reputationTagPlugins.map(plugin => plugin.sync.tick({ mgr, account })));
    expect(await maintainsSiblings()).toBe(true);
    api.status = 'unconfigured';
    await Promise.all(reputationTagPlugins.map(plugin => plugin.sync.tick({ mgr, account })));
    expect(await maintainsSiblings()).toBe(false);
    api.activated = false;
    await Promise.all(reputationTagPlugins.map(plugin => plugin.sync.tick({ mgr, account })));
    expect(await maintainsSiblings()).toBe(false);
    expect(api.logger.warn).not.toHaveBeenCalled();
  });
});
