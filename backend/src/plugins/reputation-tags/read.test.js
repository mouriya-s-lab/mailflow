import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  activated: true, configured: 'enabled', annotation: null,
  isPluginActivatedForAccount: vi.fn(), sourceStatus: vi.fn(), getMessageAnnotations: vi.fn(),
  lookupRdap: vi.fn(), lookupSpamhausDbl: vi.fn(), lookupUrlhaus: vi.fn(), lookupSafeBrowsing: vi.fn(),
  logger: { warn: vi.fn() },
}));
vi.mock('../api.js', () => ({ ...api,
  NEW_DOMAIN_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
  requireAuth: (_req,_res,next) => next(), getOwnedAccount: vi.fn(), listUserAccounts: vi.fn(),
  isPluginActivated: vi.fn(), currentUidFloors: vi.fn(), markMessages: vi.fn(), listQueuedMessages: vi.fn(), countQueued: vi.fn(),
  setMessageAnnotation: vi.fn(), ensureMessageBodies: vi.fn(), getMessageLinks: vi.fn(), reputationUrlSubject: vi.fn(),
  getAccountConfig: vi.fn(), setAccountConfig: vi.fn(), storage: { getValue: vi.fn(), put: vi.fn() },
}));
vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
import { createPluginRegistry } from '../registry.js';
import { createMessageTags } from '../../../fork-features/message-tags/index.js';
import { reputationTagPlugins } from './index.js';

const id = '00000000-0000-4000-8000-000000000044';
const accountId = '00000000-0000-4000-8000-000000000045';
const snapshot = { kind: 'complete', checkedAt: '2026-10-13T00:00:00.000Z', subjects: { 'example.com': { kind: 'known', registeredAt: '2026-10-01T00:00:00.000Z' } } };

beforeEach(() => {
  vi.clearAllMocks(); api.activated = true; api.configured = 'enabled';
  api.annotation = { revision: 0, attempts: 0, queue: { state: 'done', dueAt: null, origin: 'new_mail' }, result: snapshot };
  api.isPluginActivatedForAccount.mockImplementation(async () => api.activated);
  api.sourceStatus.mockImplementation(async () => api.configured);
  api.getMessageAnnotations.mockImplementation(async () => ({ [id]: api.annotation }));
});

function tagsApi() {
  const registry = createPluginRegistry();
  registry.register(reputationTagPlugins.find(p => p.id === 'tag-rdap'));
  return createMessageTags({ registry, now: () => Date.parse('2026-10-13T00:00:00Z'), queryFn: async () => ({ rows: [{ id, account_id: accountId }] }) });
}

describe('reputation read/ensure current availability', () => {
  it('deactivation hides a saved complete and removes its summary chip before reading annotations', async () => {
    const tags = tagsApi();
    expect((await tags.getMessageTags(accountId,[id])).get(id).rdap).toEqual(snapshot);
    expect((await tags.summarizeForUser('user',[id])).tags[id].notable).toEqual([{ kind:'new_domain', domain:'example.com', ageDays:12 }]);
    api.activated = false; api.getMessageAnnotations.mockClear();
    expect((await tags.getMessageTags(accountId,[id])).get(id).rdap).toEqual({ kind:'inactive' });
    expect((await tags.summarizeForUser('user',[id])).tags[id].notable).toEqual([]);
    expect((await tags.ensureMessageTags(accountId,[id],{ deadlineMs:100 })).get(id).rdap).toEqual({ kind:'inactive' });
    expect(api.getMessageAnnotations).not.toHaveBeenCalled();
    expect(api.lookupRdap).not.toHaveBeenCalled();
  });

  it('disabled RDAP is unconfigured rather than unchecked, whether a saved snapshot exists or not', async () => {
    const tags = tagsApi(); api.configured='disabled';
    for (const annotation of [api.annotation,null]) {
      api.annotation=annotation;
      expect((await tags.getMessageTags(accountId,[id])).get(id).rdap).toEqual({kind:'unconfigured'});
      expect((await tags.ensureMessageTags(accountId,[id],{deadlineMs:100})).get(id).rdap).toEqual({kind:'unconfigured'});
      expect((await tags.summarizeForUser('user',[id])).tags[id].notable).toEqual([]);
    }
    expect(api.getMessageAnnotations).not.toHaveBeenCalled();
    expect(api.lookupRdap).not.toHaveBeenCalled();
  });
});
