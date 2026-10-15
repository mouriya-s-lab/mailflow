import { getOwnedAccount, isPluginActivated, sourceStatus } from '../api.js';
import { REVISION } from './model.js';
import { exclusive, loadBackfill, saveBackfill } from './records.js';

const skipped = reason => ({ kind: 'skipped', reason });

async function eligibility(plugin, userId, accountId) {
  const account = await getOwnedAccount(userId, accountId);
  if (!account) return skipped('account_missing');
  if (!account.enabled) return skipped('account_disabled');
  if (account.protocol !== 'imap') return skipped('unsupported_protocol');
  if (!await isPluginActivated(userId, plugin.id, { fresh: true })) return skipped('plugin_inactive');
  const source = await sourceStatus(plugin.source);
  switch (source) {
    case 'enabled': return { kind: 'ready' };
    case 'disabled': return skipped('service_disabled');
    case 'unconfigured': return skipped('service_unconfigured');
    default: throw new Error(`Unknown reputation source state: ${source}`);
  }
}

export async function inspectBackfill(plugin, userId, accountId) {
  if (!await getOwnedAccount(userId, accountId)) {
    return { kind: 'available', eligibility: skipped('account_missing'), backfill: { kind: 'idle' } };
  }
  const [ready, backfill] = await Promise.all([
    eligibility(plugin, userId, accountId), loadBackfill(plugin.id, accountId),
  ]);
  return { kind: 'available', eligibility: ready, backfill };
}

export async function startBackfill(plugin, userId, accountId) {
  if (!await getOwnedAccount(userId, accountId)) return skipped('account_missing');
  return exclusive(plugin.id, accountId, async () => {
    const run = await loadBackfill(plugin.id, accountId);
    if (run.kind === 'running') return { kind: 'already_running', backfill: run };
    const ready = await eligibility(plugin, userId, accountId);
    if (ready.kind === 'skipped') return ready;
    const next = { kind: 'running', revision: REVISION, startedAt: new Date().toISOString(), marked: 0, processed: 0, failed: 0 };
    await saveBackfill(plugin.id, accountId, userId, next);
    return { kind: 'started', backfill: next };
  });
}
