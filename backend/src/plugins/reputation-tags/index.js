import { lookupRdap, lookupSpamhausDbl, lookupUrlhaus, lookupSafeBrowsing } from '../api.js';
import { TICK_BUDGET_MS } from './model.js';
import { runTick, requestDrain, ensure, read } from './processor.js';
import { createRoutes } from './routes.js';

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
  // The hook only wakes a tick; activation and source configuration are read by the tick itself.
  hooks: { inboxIngest: { handler: context => requestDrain(plugin, context), isActive: () => true } },
  sync: { intervalMs: TICK_BUDGET_MS, isActive: () => true, tick: context => runTick(plugin, context) },
  tagSource: {
    source: plugin.source,
    ensure: (accountId, ids, options) => ensure(plugin, accountId, ids, options),
    read: (accountId, ids) => read(plugin, accountId, ids),
  },
}));
