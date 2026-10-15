import { getOwnedAccount, isPluginActivated, jevStatus } from '../api.js';
import { PLUGIN_ID } from './model.js';
import { loadAccountConfig, loadCategories, loadBackfill, updateBackfill } from './records.js';

const skipped = reason => ({ kind: 'skipped', reason });

async function eligibility(userId, accountId) {
  const account = await getOwnedAccount(userId, accountId);
  if (!account) return skipped('account_missing');
  if (!account.enabled) return skipped('account_disabled');
  if (account.protocol !== 'imap') return skipped('unsupported_protocol');
  if (!await isPluginActivated(userId, PLUGIN_ID, { fresh: true })) return skipped('plugin_inactive');
  if (!(await loadAccountConfig(accountId)).enabled) return skipped('module_disabled');
  if ((await jevStatus()).kind !== 'configured') return skipped('service_unconfigured');
  return { kind: 'ready' };
}

export async function inspectBackfill(userId, accountId) {
  // Ownership is checked before reading the account's private plugin records.
  if (!await getOwnedAccount(userId, accountId)) {
    return { kind: 'available', eligibility: skipped('account_missing'), backfill: { kind: 'idle' } };
  }
  const [ready, backfill] = await Promise.all([eligibility(userId, accountId), loadBackfill(accountId)]);
  return { kind: 'available', eligibility: ready, backfill };
}

export async function startBackfill(userId, accountId) {
  if (!await getOwnedAccount(userId, accountId)) return skipped('account_missing');
  return updateBackfill(accountId, userId, async run => {
    // The owner arbitrates duplicate starts under the same turn as progress writes.
    if (run.kind === 'running') return { next: null, result: { kind: 'already_running', backfill: run } };
    const ready = await eligibility(userId, accountId);
    if (ready.kind === 'skipped') return { next: null, result: ready };
    const { revision } = await loadCategories(userId);
    const next = { kind: 'running', revision, startedAt: new Date().toISOString(), marked: 0, processed: 0, failed: 0 };
    return { next, result: { kind: 'started', backfill: next } };
  });
}
