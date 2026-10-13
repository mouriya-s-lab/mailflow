import {
  logger, isPluginActivated, isPluginActivatedForAccount, sourceStatus, currentUidFloors,
  markMessages, listQueuedMessages, countQueued, getMessageAnnotations, setMessageAnnotation,
  ensureMessageBodies, getMessageLinks, reputationUrlSubject,
} from '../api.js';
import {
  REVISION, TICK_BUDGET_MS, TICK_MAX_MESSAGES, MIN_MESSAGE_BUDGET_MS, NEW_MAIL_MARK_LIMIT,
  BACKFILL_BATCH, QUEUE_READ_LIMIT, refreshFloors, parseAnnotation, parseResult, bodyGate, failedAttempt,
} from './model.js';
import { currentTurn, exclusive, loadFloors, saveFloors, loadBackfill, saveBackfill, recordProcessed } from './records.js';

export async function read(plugin, accountId, ids) {
  const annotations = await getMessageAnnotations(accountId, ids, plugin.id);
  return new Map(ids.map(id => [id, parseAnnotation(plugin.source, annotations[id])?.result ?? { kind: 'unchecked' }]));
}

export function runTick(plugin, { mgr, account }) {
  const current = currentTurn(plugin.id, account.id);
  if (current) return current;
  const startedAt = Date.now();
  return exclusive(plugin.id, account.id, async () => {
    try {
      if (!mgr.isConnected(account.id) || !(await isPluginActivated(account.user_id, plugin.id))) return;
      // Record floors even without a key: configuring a source later must pick up mail received
      // since the first activated tick, not redefine all of it as history.
      const refreshed = refreshFloors(await loadFloors(plugin.id, account.id), await currentUidFloors({ accountId: account.id }));
      if (refreshed.changed) await saveFloors(plugin.id, account.id, refreshed.floors);
      if (await sourceStatus(plugin.source) !== 'enabled') return;
      await markMessages({ accountId: account.id, pluginId: plugin.id, scope: { kind: 'above_uid_floor', floors: refreshed.floors }, revision: REVISION, origin: 'new_mail', limit: NEW_MAIL_MARK_LIMIT });
      await advanceBackfill(plugin, account);
      const queued = await listQueuedMessages({ accountId: account.id, pluginId: plugin.id, now: new Date(), limit: QUEUE_READ_LIMIT });
      const ordered = [...queued.filter(r => r.plugin_annotation.queue.origin === 'new_mail'), ...queued.filter(r => r.plugin_annotation.queue.origin !== 'new_mail')];
      const deadlineAt = startedAt + TICK_BUDGET_MS;
      const work = ordered.slice(0, TICK_MAX_MESSAGES);
      const bodies = work.length && deadlineAt - Date.now() >= MIN_MESSAGE_BUDGET_MS
        ? await ensureMessageBodies(account.id, work.map(row => row.id), { deadlineMs: deadlineAt - Date.now() }) : new Map();
      for (const row of work) {
        if (deadlineAt - Date.now() < MIN_MESSAGE_BUDGET_MS) break;
        try {
          await processMessage(plugin, account.id, row.id, parseAnnotation(plugin.source, row.plugin_annotation), bodies.get(row.id), deadlineAt);
        } catch (err) {
          logger.warn(`${plugin.id}: message ${row.id} failed: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`${plugin.id}: tick failed for account ${account.id}: ${err.message}`);
    }
  });
}

export function requestDrain(plugin, context) {
  setImmediate(() => { runTick(plugin, context); });
}

async function advanceBackfill(plugin, account) {
  const run = await loadBackfill(plugin.id, account.id);
  if (run.kind !== 'running') return;
  const counts = await countQueued({ accountId: account.id, pluginId: plugin.id, origin: 'backfill' });
  if (counts.pending > 0) return;
  const marked = await markMessages({ accountId: account.id, pluginId: plugin.id, scope: { kind: 'not_at_revision' }, revision: REVISION, origin: 'backfill', limit: BACKFILL_BATCH });
  if (marked > 0) {
    await saveBackfill(plugin.id, account.id, account.user_id, { ...run, marked: run.marked + marked });
  } else if (counts.retry === 0) {
    await saveBackfill(plugin.id, account.id, account.user_id, { ...run, kind: 'completed', finishedAt: new Date().toISOString() });
  }
}

export function ensure(plugin, accountId, ids, { deadlineMs }) {
  const deadlineAt = Date.now() + deadlineMs;
  return exclusive(plugin.id, accountId, async () => {
    const states = await read(plugin, accountId, ids);
    if (!(await isPluginActivatedForAccount(plugin.id, accountId))) return new Map(ids.map(id => [id, { kind: 'inactive' }]));
    if (await sourceStatus(plugin.source) !== 'enabled') return new Map(ids.map(id => [id, { kind: 'unconfigured' }]));
    const missing = ids.filter(id => states.get(id).kind !== 'complete');
    const annotations = await getMessageAnnotations(accountId, missing, plugin.id);
    const bodies = missing.length && deadlineAt > Date.now()
      ? await ensureMessageBodies(accountId, missing, { deadlineMs: deadlineAt - Date.now() }) : new Map();
    for (const id of missing) {
      const annotation = parseAnnotation(plugin.source, annotations[id]) ?? { revision: REVISION, attempts: 0, queue: { state: 'pending', dueAt: null, origin: 'new_mail' } };
      const state = await processMessage(plugin, accountId, id, annotation, bodies.get(id), deadlineAt);
      states.set(id, state);
    }
    return states;
  });
}

async function processMessage(plugin, accountId, id, annotation, body, deadlineAt) {
  if (deadlineAt <= Date.now()) return { kind: 'unavailable', reason: 'deadline' };
  const gate = bodyGate(body);
  if (gate !== 'ready') return { kind: 'unavailable', reason: gate };
  if (await sourceStatus(plugin.source) !== 'enabled') return { kind: 'unconfigured' };
  const links = (await getMessageLinks(accountId, [id])).get(id);
  if (!links) throw new Error('message disappeared while reading links');
  const subjectsToCheck = [...new Set(links.map(link => plugin.source === 'safe_browsing' ? link.href : link.hrefDomain).filter(Boolean))];
  if (deadlineAt <= Date.now()) return { kind: 'unavailable', reason: 'deadline' };
  const answers = await plugin.lookup(subjectsToCheck, { deadlineMs: deadlineAt - Date.now() });
  if (await sourceStatus(plugin.source) !== 'enabled') return { kind: 'unconfigured' };
  const subjects = {};
  let unknown = false;
  for (const subject of subjectsToCheck) {
    const answer = answers.get(subject);
    if (!answer) throw new Error('source omitted a requested subject');
    if (answer.kind === 'unconfigured' || (answer.kind === 'unknown' && answer.reason === 'disabled')) return { kind: 'unconfigured' };
    unknown ||= answer.kind === 'unknown';
    if (plugin.source === 'safe_browsing') {
      const { urlDigest, host } = reputationUrlSubject(subject);
      subjects[urlDigest] = { host, verdict: answer };
    } else subjects[subject] = answer;
  }
  if (deadlineAt <= Date.now()) return { kind: 'unavailable', reason: 'deadline' };
  const now = new Date();
  const result = parseResult(plugin.source, { kind: 'complete', checkedAt: now.toISOString(), subjects });
  const patch = unknown ? failedAttempt(annotation, 'source_unknown', now, result) : {
    revision: REVISION, attempts: annotation.attempts, queue: { state: 'done', dueAt: null, origin: annotation.queue.origin }, result,
  };
  const written = await setMessageAnnotation(accountId, id, plugin.id, patch);
  if (written.kind === 'message_missing') throw new Error('message disappeared while storing tag');
  if (written.kind !== 'written') throw new Error(`unknown annotation write outcome ${written.kind}`);
  if (annotation.queue.origin === 'backfill' && patch.queue.state === 'done') {
    await recordProcessed(plugin.id, accountId);
  }
  return result;
}
