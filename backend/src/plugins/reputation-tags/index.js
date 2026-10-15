import { lookupRdap, lookupSpamhausDbl, lookupUrlhaus, lookupSafeBrowsing } from '../api.js';
import { TICK_BUDGET_MS } from './model.js';
import { runTick, requestDrain, newMailDrainActive, ensure, read } from './processor.js';
import { createRoutes } from './routes.js';
import { inspectBackfill, startBackfill } from './backfill.js';

const definitions = [
  { id: 'tag-rdap', name: 'RDAP tags', source: 'rdap', lookup: lookupRdap },
  { id: 'tag-spamhaus', name: 'Spamhaus DBL tags', source: 'spamhaus_dbl', lookup: lookupSpamhausDbl },
  { id: 'tag-urlhaus', name: 'URLhaus tags', source: 'urlhaus', lookup: lookupUrlhaus },
  { id: 'tag-safebrowsing', name: 'Safe Browsing tags', source: 'safe_browsing', lookup: lookupSafeBrowsing },
];

export const reputationTagPlugins = definitions.map(plugin => ({
  id: plugin.id,
  name: plugin.name,
  version: '1.0.0',
  tier: 1,
  router: { base: `/api/${plugin.id}`, handler: createRoutes(plugin) },
  backfill: {
    inspect: (userId, accountId) => inspectBackfill(plugin, userId, accountId),
    start: (userId, accountId) => startBackfill(plugin, userId, accountId),
  },
  // The hook only wakes a tick; its last-tick activation gate does no I/O in the sync loop.
  hooks: { inboxIngest: { handler: context => requestDrain(plugin, context), isActive: ({ account }) => newMailDrainActive(plugin.id, account?.id) } },
  sync: { intervalMs: TICK_BUDGET_MS, isActive: () => true, tick: context => runTick(plugin, context) },
  tagSource: {
    source: plugin.source,
    ensure: (accountId, ids, options) => ensure(plugin, accountId, ids, options),
    read: (accountId, ids) => read(plugin, accountId, ids),
  },
}));
