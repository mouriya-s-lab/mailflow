// Jev classification plugin — the sync tick.
//
// One tick per account and interval (sync.tick), and one more when new INBOX mail arrives
// (inboxIngest → requestDrain). A tick runs at most once at a time per account; a tick asked
// for while one runs joins it. Within a tick: read the configuration, mark new mail and the next
// backfill batch, then work through the queue — at most TICK_MAX_MESSAGES messages, and no
// message is started once less than MIN_MESSAGE_BUDGET_MS is left of TICK_BUDGET_MS. The time
// left goes to the signal read, the reputation lookup and Jev as their deadline. Training
// records, moves and labels take no deadline, so a tick can end after its budget by the tail of
// the one message it already started.

import {
  logger, isPluginActivated, markMessages, currentUidFloors, listQueuedMessages, countQueued,
  setMessageAnnotation, getMessageSignals, getMessageBodyTexts, lookupDomainReputation, jevDecide,
  recordJevSpamVerdict, requestSpamRetrain, ensureSpamVerdict, moveMessagesVerified,
  isLabelStoreAccount, applyLabel, ensureLabelFolders,
} from '../api.js';
import {
  PLUGIN_ID, refreshFloors, parseAnnotation, normalize, promote, questionsDue, executable,
  classifyJevError, failDecisions, applyAnswers, trainingOutcome, failTraining, failAction,
  actionForMove, deriveQueue, buildJevRequest, linkDomains,
} from './model.js';
import {
  loadAccountConfig, updateAccountConfig, loadCategories, updateBackfill, appendIncident,
  recordLastDecision,
} from './records.js';

export const TICK_BUDGET_MS = 60_000;
export const TICK_MAX_MESSAGES = 50;
export const MIN_MESSAGE_BUDGET_MS = 5_000;
const NEW_MAIL_MARK_LIMIT = 200;
const BACKFILL_BATCH = 50;
const QUEUE_READ_LIMIT = 200;

const running = new Map(); // accountId -> the running tick
const jevCalls = new Map(); // accountId -> Jev requests sent by this process

// Accounts whose new INBOX mail should start a tick at once: activated, enabled and classifying
// new mail. A copy of their configuration taken by the last tick or settings write, read by the
// inboxIngest gate so the sync loop does no I/O for it. A stale entry only moves when new mail
// is picked up, never whether: every interval tick reads the configuration itself.
const newMailAccounts = new Set();

export const newMailDrainActive = accountId => newMailAccounts.has(accountId);
export function noteNewMailDrain(accountId, active) {
  if (active) newMailAccounts.add(accountId);
  else newMailAccounts.delete(accountId);
}
export const jevCallCount = accountId => jevCalls.get(accountId) ?? 0;

// Starts a tick for the account unless one is running; resolves when that tick is over.
export function runTick({ mgr, account }) {
  const current = running.get(account.id);
  if (current) return current;
  const tick = (async () => {
    try {
      await tickBody(mgr, account, Date.now());
    } catch (err) {
      logger.warn(`jev-classify: tick failed for account ${account.id}: ${err.message}`);
    } finally {
      running.delete(account.id);
    }
  })();
  running.set(account.id, tick);
  return tick;
}

// inboxIngest: schedule a tick on the next turn of the event loop and return. The sync loop's
// call does nothing but that.
export function requestDrain({ mgr, account }) {
  setImmediate(() => { runTick({ mgr, account }); });
}

async function tickBody(mgr, account, startedAt) {
  if (!mgr.isConnected(account.id)) return;
  const activated = await isPluginActivated(account.user_id, PLUGIN_ID);
  const config = await loadAccountConfig(account.id);
  noteNewMailDrain(account.id, activated && config.enabled && config.classifyNewMail);
  if (!activated || !config.enabled) return;

  const categories = await loadCategories(account.user_id);
  if (config.classifyNewMail) await markNewMail(account, categories.revision);
  await advanceBackfill(account, categories.revision);

  const ctx = {
    mgr, account, config, categories,
    deadline: startedAt + TICK_BUDGET_MS,
    labelStore: isLabelStoreAccount(account),
    targets: new Map(),
    jevUnconfigured: false,
  };
  const results = await processQueue(ctx);
  await recordTick(ctx, results);
}

// ── Marking ───────────────────────────────────────────────────────────────────

async function markNewMail(account, revision) {
  const floors = await updateAccountConfig(account.id, async config => {
    if (!config.enabled || !config.classifyNewMail) return { next: null, result: null };
    const refreshed = refreshFloors(config.newMailFloors, await currentUidFloors({ accountId: account.id }));
    return { next: refreshed.changed ? { ...config, newMailFloors: refreshed.floors } : null, result: refreshed.floors };
  });
  if (!floors) return;
  await markMessages({
    accountId: account.id, pluginId: PLUGIN_ID, scope: { kind: 'above_uid_floor', floors },
    revision, origin: 'new_mail', limit: NEW_MAIL_MARK_LIMIT,
  });
}

// A running backfill marks its next batch once the previous one has been worked off, so new
// mail never waits behind the whole history; it completes when nothing is left to mark and no
// backfill message waits for a retry.
async function advanceBackfill(account, revision) {
  await updateBackfill(account.id, account.user_id, async run => {
    if (run.kind !== 'running') return { next: null };
    const counts = await countQueued({ accountId: account.id, pluginId: PLUGIN_ID, origin: 'backfill' });
    if (counts.pending > 0) return { next: null };
    const marked = await markMessages({
      accountId: account.id, pluginId: PLUGIN_ID, scope: { kind: 'not_at_revision' },
      revision, origin: 'backfill', limit: BACKFILL_BATCH,
    });
    if (marked > 0) return { next: { ...run, marked: run.marked + marked } };
    if (counts.retry > 0) return { next: null };
    return {
      next: {
        kind: 'completed', revision: run.revision, startedAt: run.startedAt, finishedAt: new Date().toISOString(),
        marked: run.marked, processed: run.processed, failed: run.failed,
      },
    };
  });
}

// ── Processing ────────────────────────────────────────────────────────────────

const remaining = ctx => ctx.deadline - Date.now();

async function processQueue(ctx) {
  const { account } = ctx;
  const now = new Date();
  const queued = await listQueuedMessages({ accountId: account.id, pluginId: PLUGIN_ID, now, limit: QUEUE_READ_LIMIT });
  // New mail first; within an origin the queue's own order.
  const ordered = [...queued.filter(r => r.plugin_annotation.queue?.origin === 'new_mail'), ...queued.filter(r => r.plugin_annotation.queue?.origin !== 'new_mail')];
  const work = [];
  for (const row of ordered.slice(0, TICK_MAX_MESSAGES)) {
    try {
      const annotation = parseAnnotation(row.plugin_annotation);
      work.push({ row, annotation, lines: promote(normalize(annotation, { trainSpam: ctx.config.trainSpam })) });
    } catch (err) {
      logger.warn(`jev-classify: message ${row.id} skipped: ${err.message}`);
    }
  }

  const askIds = work.filter(w => { const due = questionsDue(w.lines, now); return due.category || due.spam; }).map(w => w.row.id);
  const [signals, bodies] = askIds.length && remaining(ctx) >= MIN_MESSAGE_BUDGET_MS
    ? await Promise.all([
      getMessageSignals(account.id, askIds, { deadlineMs: remaining(ctx) }),
      getMessageBodyTexts(account.id, askIds),
    ])
    : [new Map(), new Map()];

  const results = [];
  for (const item of work) {
    if (remaining(ctx) < MIN_MESSAGE_BUDGET_MS) break;
    try {
      results.push(await processMessage(ctx, item, { signals, bodies }));
    } catch (err) {
      logger.warn(`jev-classify: message ${item.row.id} failed: ${err.message}`);
    }
  }
  return results;
}

// One message: the Jev decisions it needs, then training, then the action; then one write of
// every segment and the queue they project to. Resolves to
//   { kind: 'written', origin, queue, decided, trained } | { kind: 'discarded' } | { kind: 'not_run' }.
async function processMessage(ctx, { row, annotation, lines: start }, { signals, bodies }) {
  const now = new Date();
  let lines = start;
  let decidedAt = null;
  let trained = false;

  const asked = questionsDue(lines, now);
  if (asked.category || asked.spam) {
    if (ctx.jevUnconfigured) return { kind: 'not_run' };
    const messageSignals = signals.get(row.id);
    if (!messageSignals) {
      // Not read this tick (no time was left), or the row is gone; it stays queued as it is.
      return { kind: 'not_run' };
    }
    const decision = await decide(ctx, row, messageSignals, bodies.get(row.id) ?? '', asked, annotation.revision, lines);
    if (decision.kind === 'unconfigured') {
      ctx.jevUnconfigured = true;
      return { kind: 'not_run' };
    }
    lines = promote(decision.lines);
    decidedAt = decision.decidedAt;
  }

  if (lines.spam && executable(lines.spam.training, now)) {
    const training = await train(row, lines.spam.training, now);
    if (training.kind === 'message_missing') return { kind: 'discarded' };
    lines = { category: lines.category, spam: { decision: lines.spam.decision, training: training.segment } };
    trained = training.segment.kind === 'recorded';
  }

  if (executable(lines.category.action, now)) {
    lines = { category: { decision: lines.category.decision, action: await route(ctx, row, lines.category, now) }, spam: lines.spam };
  }

  const queue = { ...deriveQueue(lines), origin: annotation.queue.origin };
  const patch = { revision: annotation.revision, queue, category: lines.category, ...(lines.spam ? { spam: lines.spam } : {}) };
  const written = await setMessageAnnotation(ctx.account.id, row.id, PLUGIN_ID, patch);
  switch (written.kind) {
    case 'written':
      return { kind: 'written', origin: annotation.queue.origin, queue, decided: decidedAt, trained };
    case 'message_missing':
      return { kind: 'discarded' };
    default:
      throw new Error(`unhandled annotation write result ${JSON.stringify(written.kind)}`);
  }
}

// The Jev decisions asked this attempt: { kind: 'unconfigured' } | { kind: 'applied', lines, decidedAt }.
async function decide(ctx, row, signals, bodyText, asked, revision, lines) {
  const now = new Date();
  let reputation;
  try {
    reputation = await lookupDomainReputation(linkDomains(signals), { deadlineMs: remaining(ctx) });
  } catch (err) {
    logger.warn(`jev-classify: link reputation failed for message ${row.id}: ${err.message}`);
    return { kind: 'applied', lines: failDecisions(lines, asked, { kind: 'retry', errorKind: 'reputation_error' }, now), decidedAt: null };
  }
  const request = buildJevRequest({ signals, reputation, bodyText, categories: ctx.categories.categories, asked });
  const result = await jevDecide(request, { deadlineMs: remaining(ctx) });
  if (result.kind === 'ok') {
    countJevCall(ctx.account.id);
    const answeredAt = new Date();
    return { kind: 'applied', lines: applyAnswers(lines, asked, result, { revision, now: answeredAt }), decidedAt: answeredAt.toISOString() };
  }
  const failure = classifyJevError(result.error);
  switch (failure.kind) {
    case 'unconfigured':
      return { kind: 'unconfigured' };
    case 'retry':
      countJevCall(ctx.account.id);
      return { kind: 'applied', lines: failDecisions(lines, asked, failure, now), decidedAt: null };
    case 'terminal':
      if (result.error.kind !== 'invalid_request') countJevCall(ctx.account.id);
      logger.warn(`jev-classify: Jev decision for message ${row.id} failed for good: ${failure.errorKind}`);
      return { kind: 'applied', lines: failDecisions(lines, asked, failure, now), decidedAt: null };
    default:
      throw new Error(`unhandled Jev failure ${JSON.stringify(failure.kind)}`);
  }
}

function countJevCall(accountId) {
  jevCalls.set(accountId, jevCallCount(accountId) + 1);
}

// { kind: 'segment', segment } | { kind: 'message_missing' }
async function train(row, training, now) {
  let result;
  try {
    result = await recordJevSpamVerdict({ messageId: row.id, label: training.label });
  } catch (err) {
    logger.warn(`jev-classify: training record for message ${row.id} failed: ${err.message}`);
    return { kind: 'segment', segment: failTraining(training, now) };
  }
  if (result.kind === 'message_missing') return { kind: 'message_missing' };
  return { kind: 'segment', segment: trainingOutcome(training.label, result) };
}

// The category action: route an INBOX message to the folder its category maps to.
async function route(ctx, row, category, now) {
  const { action, decision } = category;
  const target = ctx.config.routing[decision.choice] ?? null;
  if (row.folder !== 'INBOX') return { kind: 'skipped', reason: 'not_in_inbox' };

  let verdict;
  try {
    verdict = await ensureSpamVerdict(row.id);
  } catch (err) {
    logger.warn(`jev-classify: anti-spam verdict for message ${row.id} failed: ${err.message}`);
    return failAction(action, target, 'spam_verdict_error', now);
  }
  switch (verdict.kind) {
    case 'verdict':
      if (verdict.verdict === 'spam' || verdict.override === 'spam') return { kind: 'skipped', reason: 'spam' };
      break;
    case 'disabled':
      break;
    case 'error':
      return failAction(action, target, `spam_verdict_${verdict.reason}`, now);
    default:
      throw new Error(`unhandled anti-spam verdict ${JSON.stringify(verdict.kind)}`);
  }

  if (decision.confidence < ctx.config.routingMinConfidence) return { kind: 'skipped', reason: 'low_confidence' };
  if (!target) return { kind: 'skipped', reason: 'unmapped' };
  if (!row.message_id) return { kind: 'skipped', reason: 'no_message_id' };

  const folder = await resolveTarget(ctx, target);
  switch (folder.kind) {
    case 'ready':
      break;
    case 'missing':
      return { kind: 'terminal_failed', target, outcome: 'folder_missing' };
    case 'failed':
      return failAction(action, target, folder.outcome, now);
    default:
      throw new Error(`unhandled folder resolution ${JSON.stringify(folder.kind)}`);
  }

  if (ctx.labelStore) {
    try {
      await applyLabel(ctx.account, { account_id: ctx.account.id, uid: row.uid, folder: row.folder, message_id: row.message_id }, folder.path);
    } catch (err) {
      logger.warn(`jev-classify: label for message ${row.id} failed: ${err.message}`);
      return failAction(action, folder.path, 'label_failed', now);
    }
    return { kind: 'done', target: folder.path, effect: 'labeled' };
  }

  let outcome;
  try {
    outcome = (await moveMessagesVerified({ accountId: ctx.account.id, messageIds: [row.id], toFolder: folder.path })).get(row.id);
  } catch (err) {
    logger.warn(`jev-classify: move of message ${row.id} failed: ${err.message}`);
    return failAction(action, folder.path, 'move_error', now);
  }
  const mapped = actionForMove(action, folder.path, outcome, now);
  if (mapped.incident) {
    await appendIncident(ctx.account.id, ctx.account.user_id, {
      messageId: row.message_id, target: folder.path, outcome: outcome.kind, at: now.toISOString(),
    });
  }
  return mapped.action;
}

// The folder a target names on the server, resolved once per tick:
//   { kind: 'ready', path } | { kind: 'missing' } | { kind: 'failed', outcome }.
// With createFolders the folder is created when absent and synced once so MailFlow knows it;
// without, a label folder MailFlow does not know is missing (a plain move finds out itself).
function resolveTarget(ctx, target) {
  if (!ctx.targets.has(target)) ctx.targets.set(target, resolveTargetOnce(ctx, target));
  return ctx.targets.get(target);
}

async function resolveTargetOnce(ctx, target) {
  const { account, mgr } = ctx;
  if (!ctx.config.createFolders) {
    if (!ctx.labelStore) return { kind: 'ready', path: target };
    const known = await currentUidFloors({ accountId: account.id });
    return Object.hasOwn(known, target) ? { kind: 'ready', path: target } : { kind: 'missing' };
  }
  const [ensured] = await ensureLabelFolders(account, [target]);
  if (!ensured || ensured.error) return { kind: 'failed', outcome: 'folder_create_failed' };
  const known = await currentUidFloors({ accountId: account.id });
  if (!Object.hasOwn(known, ensured.path)) {
    try {
      await mgr.syncFolderViaPool(account, ensured.path);
    } catch (err) {
      logger.warn(`jev-classify: first sync of folder for account ${account.id} failed: ${err.message}`);
      return { kind: 'failed', outcome: 'folder_sync_failed' };
    }
  }
  return { kind: 'ready', path: ensured.path };
}

// ── After the queue ───────────────────────────────────────────────────────────

async function recordTick(ctx, results) {
  const { account } = ctx;
  const written = results.filter(r => r.kind === 'written');
  const finished = written.filter(r => r.origin === 'backfill' && (r.queue.state === 'done' || r.queue.state === 'terminal'));
  if (finished.length) {
    const failed = finished.filter(r => r.queue.state === 'terminal').length;
    await updateBackfill(account.id, account.user_id, async run => (run.kind === 'running'
      ? { next: { ...run, processed: run.processed + finished.length, failed: run.failed + failed } }
      : { next: null }));
  }
  const decidedAt = written.map(r => r.decided).filter(Boolean).sort().at(-1);
  if (decidedAt) await recordLastDecision(account.id, account.user_id, decidedAt);
  if (written.some(r => r.trained)) {
    requestSpamRetrain(account.user_id)
      .then(result => {
        if (result.kind === 'failed') logger.warn(`jev-classify: anti-spam retrain for user ${account.user_id} failed: ${result.reason}`);
      })
      .catch(err => logger.warn(`jev-classify: anti-spam retrain for user ${account.user_id} failed: ${err.message}`));
  }
}
