// Jev classification plugin manifest (Tier-1, bundled; fork-only, mouriya-s-lab/mailflow#17).
//
// Asks Jev to classify each message of an account, routes INBOX mail to the folder (or, on Gmail,
// the label) the user mapped its category to, and can feed Jev's confident spam/ham verdicts to
// anti-spam training. Per user it is switched on through plugin activation; per account through
// its own configuration (routes.js). The work happens in the sync tick (processor.js).
import routes from './routes.js';
import { runTick, requestDrain, newMailDrainActive } from './processor.js';
import { PLUGIN_ID } from './model.js';
import { inspectBackfill, startBackfill } from './backfill.js';

export const jevClassifyPlugin = {
  id: PLUGIN_ID,
  name: 'Jev classification',
  version: '1.0.0',
  tier: 1,
  router: { base: '/api/jev-classify', handler: routes },
  backfill: { inspect: inspectBackfill, start: startBackfill },
  hooks: {
    // New INBOX mail starts a tick right away. The gate is an in-memory read so the sync loop
    // does no I/O for this plugin; the interval tick picks up the mail either way.
    inboxIngest: { handler: requestDrain, isActive: ({ account }) => newMailDrainActive(account?.id) },
  },
  // Armed for every connected account: the tick reads the user's activation and the account's
  // configuration itself each time, so switching the plugin on needs no reconnect.
  sync: {
    intervalMs: 60_000,
    isActive: () => true,
    tick: runTick,
  },
};
