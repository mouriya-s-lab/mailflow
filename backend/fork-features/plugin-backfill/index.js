import { pluginRegistry } from '../../src/plugins/registry.js';
import { getActivatedPlugins } from '../../src/plugins/activation.js';
import { listUserAccounts } from '../../src/services/mailAccess.js';
import { logger } from '../../src/services/logger.js';

// These are command results and read snapshots, never another owner of a plugin's run.
export async function inspectBackfills(userId) {
  const [activated, accounts] = await Promise.all([getActivatedPlugins(userId, { fresh: true }), listUserAccounts(userId)]);
  const plugins = await Promise.all(pluginRegistry.list().map(async plugin => ({
    id: plugin.id,
    name: plugin.name,
    activated: activated.has(plugin.id),
    supported: Boolean(plugin.backfill),
    accounts: plugin.backfill ? await Promise.all(accounts.map(async account => {
      let status;
      try {
        status = await plugin.backfill.inspect(userId, account.id);
      } catch (err) {
        logger.warn(`plugin-backfill: status failed for ${plugin.id}/${account.id}: ${err.message}`);
        status = { kind: 'failed', error: 'status_failed' };
      }
      return { id: account.id, emailAddress: account.email_address, status };
    })) : [],
  })));
  return { plugins };
}

export async function startBackfills(userId) {
  const [activated, accounts] = await Promise.all([getActivatedPlugins(userId, { fresh: true }), listUserAccounts(userId)]);
  const plugins = pluginRegistry.list().filter(plugin => plugin.backfill && activated.has(plugin.id));
  // Each owner confirms eligibility and persists its run before acknowledging the command.
  // Do not tie dispatch to the HTTP connection or cancel siblings after an individual failure.
  const results = await Promise.all(plugins.flatMap(plugin => accounts.map(async account => {
    let outcome;
    try {
      outcome = await plugin.backfill.start(userId, account.id);
    } catch (err) {
      logger.warn(`plugin-backfill: start failed for ${plugin.id}/${account.id}: ${err.message}`);
      outcome = { kind: 'failed', error: 'start_failed' };
    }
    return { pluginId: plugin.id, pluginName: plugin.name, accountId: account.id, emailAddress: account.email_address, outcome };
  })));
  return { results };
}
