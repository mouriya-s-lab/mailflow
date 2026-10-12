// Jev classification plugin — HTTP interface, mounted at /api/jev-classify.
//
// Every route needs a session and acts only on the user's own categories and accounts. A body is
// parsed on the server into the plugin's model; an invalid one is a 400 with `fields`, one
// message per offending field, and nothing is written.

import { Router } from 'express';
import {
  requireAuth, getOwnedAccount, listUserAccounts, isLabelStoreAccount, isPluginActivated,
  currentUidFloors, countQueued, listQueuedMessages, listMessagesInQueueState, setMessageAnnotation,
  jevStatus, reputationStatus,
} from '../api.js';
import {
  PLUGIN_ID, parseCategoriesBody, parseAccountSettingsBody, parseAnnotation, resetTerminal,
  deriveQueue,
} from './model.js';
import {
  loadCategories, saveCategories, loadAccountConfig, updateAccountConfig, loadBackfill,
  updateBackfill, loadIncidents, clearIncidents, loadStats,
} from './records.js';
import { jevCallCount, noteNewMailDrain } from './processor.js';

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 200;
const FAR_FUTURE = new Date(8.64e15);

const invalid = (res, fields) => res.status(400).json({ error: 'Invalid request', fields });

// The user's account named by :id, or a response already sent (400 for a malformed id, 404 for
// an account that is not theirs).
async function ownedAccount(req, res) {
  const { id } = req.params;
  if (!UUID_RE.test(id)) { invalid(res, { id: 'must be an account id' }); return null; }
  const account = await getOwnedAccount(req.session.userId, id);
  if (!account) { res.status(404).json({ error: 'Account not found' }); return null; }
  return account;
}

const settingsOf = config => ({
  enabled: config.enabled,
  classifyNewMail: config.classifyNewMail,
  routing: config.routing,
  createFolders: config.createFolders,
  trainSpam: config.trainSpam,
  routingMinConfidence: config.routingMinConfidence,
});

async function accountView(account) {
  const [config, floors] = await Promise.all([
    loadAccountConfig(account.id),
    currentUidFloors({ accountId: account.id }),
  ]);
  return {
    id: account.id,
    emailAddress: account.email_address,
    labelStore: isLabelStoreAccount(account),
    config: settingsOf(config),
    newMailFloors: config.newMailFloors,
    folders: Object.keys(floors).sort(),
  };
}

// ── Categories ────────────────────────────────────────────────────────────────

router.get('/categories', async (req, res) => {
  res.json(await loadCategories(req.session.userId));
});

router.put('/categories', async (req, res) => {
  const parsed = parseCategoriesBody(req.body);
  if (!parsed.ok) return invalid(res, parsed.fields);
  const revision = await saveCategories(req.session.userId, parsed.value);
  res.json({ revision });
});

// ── Accounts ──────────────────────────────────────────────────────────────────

router.get('/accounts', async (req, res) => {
  const { userId } = req.session;
  const accounts = await Promise.all((await listUserAccounts(userId)).map(a => getOwnedAccount(userId, a.id)));
  res.json(await Promise.all(accounts.filter(Boolean).map(accountView)));
});

router.put('/accounts/:id', async (req, res) => {
  const account = await ownedAccount(req, res);
  if (!account) return;
  const { userId } = req.session;
  const { categories } = await loadCategories(userId);
  const parsed = parseAccountSettingsBody(req.body, categories.map(c => c.id));
  if (!parsed.ok) return invalid(res, parsed.fields);
  const settings = parsed.value;
  const config = await updateAccountConfig(account.id, async previous => {
    // New mail is what arrives after classifyNewMail is switched on: its floors are taken then.
    let newMailFloors = {};
    if (settings.classifyNewMail) {
      newMailFloors = previous.classifyNewMail ? previous.newMailFloors : await currentUidFloors({ accountId: account.id });
    }
    const next = { ...settings, newMailFloors };
    return { next, result: next };
  });
  const activated = await isPluginActivated(userId, PLUGIN_ID);
  noteNewMailDrain(account.id, activated && config.enabled && config.classifyNewMail);
  res.json(await accountView(account));
});

// ── Backfill ──────────────────────────────────────────────────────────────────

router.post('/accounts/:id/backfill', async (req, res) => {
  const account = await ownedAccount(req, res);
  if (!account) return;
  const { revision } = await loadCategories(req.session.userId);
  const outcome = await updateBackfill(account.id, req.session.userId, async run => {
    if (run.kind === 'running') return { next: null, result: { started: false, run } };
    const next = { kind: 'running', revision, startedAt: new Date().toISOString(), marked: 0, processed: 0, failed: 0 };
    return { next, result: { started: true, run: next } };
  });
  if (!outcome.started) return res.status(409).json({ error: 'A backfill is already running', backfill: outcome.run });
  res.json({ backfill: outcome.run });
});

router.delete('/accounts/:id/backfill', async (req, res) => {
  const account = await ownedAccount(req, res);
  if (!account) return;
  const outcome = await updateBackfill(account.id, req.session.userId, async run => {
    if (run.kind !== 'running') return { next: null, result: { stopped: false, run } };
    const next = {
      kind: 'stopped', revision: run.revision, startedAt: run.startedAt, stoppedAt: new Date().toISOString(),
      marked: run.marked, processed: run.processed, failed: run.failed,
    };
    return { next, result: { stopped: true, run: next } };
  });
  if (!outcome.stopped) return res.status(409).json({ error: 'No backfill is running', backfill: outcome.run });
  res.json({ backfill: outcome.run });
});

// ── Status ────────────────────────────────────────────────────────────────────

// When the account's queue next has work: none queued, due now, or the earliest retry time.
async function nextDue(accountId) {
  const [first] = await listQueuedMessages({ accountId, pluginId: PLUGIN_ID, now: FAR_FUTURE, limit: 1 });
  if (!first) return { kind: 'none' };
  const { state, dueAt } = first.plugin_annotation.queue;
  if (state === 'pending' || Date.parse(dueAt) <= Date.now()) return { kind: 'due_now' };
  return { kind: 'scheduled', dueAt };
}

router.get('/status', async (req, res) => {
  const { userId } = req.session;
  const [activated, jev, reputation, accounts] = await Promise.all([
    isPluginActivated(userId, PLUGIN_ID),
    jevStatus(),
    reputationStatus(),
    listUserAccounts(userId),
  ]);
  const perAccount = await Promise.all(accounts.map(async account => {
    const [config, backfillCounts, newMailCounts, due, backfill, incidents, stats] = await Promise.all([
      loadAccountConfig(account.id),
      countQueued({ accountId: account.id, pluginId: PLUGIN_ID, origin: 'backfill' }),
      countQueued({ accountId: account.id, pluginId: PLUGIN_ID, origin: 'new_mail' }),
      nextDue(account.id),
      loadBackfill(account.id),
      loadIncidents(account.id),
      loadStats(account.id),
    ]);
    return {
      id: account.id,
      emailAddress: account.email_address,
      state: activated && config.enabled ? 'enabled' : 'paused',
      queue: { backfill: backfillCounts, new_mail: newMailCounts },
      nextDue: due,
      terminalFailed: backfillCounts.terminal + newMailCounts.terminal,
      backfill,
      lastDecidedAt: stats.lastDecidedAt,
      jevCalls: jevCallCount(account.id),
      incidents,
    };
  }));
  res.json({ activated, jev, reputation, accounts: perAccount });
});

// ── Recovery ──────────────────────────────────────────────────────────────────

// Every terminal_failed segment of the account back to its runnable start, attempts cleared.
router.post('/accounts/:id/retry-failed', async (req, res) => {
  const account = await ownedAccount(req, res);
  if (!account) return;
  let reset = 0;
  let afterId = null;
  for (;;) {
    const rows = await listMessagesInQueueState({ accountId: account.id, pluginId: PLUGIN_ID, state: 'terminal', afterId, limit: PAGE });
    for (const row of rows) {
      const annotation = parseAnnotation(row.plugin_annotation);
      if (!annotation.category) continue;
      const lines = resetTerminal({ category: annotation.category, spam: annotation.spam });
      const queue = { ...deriveQueue(lines), origin: annotation.queue.origin };
      const written = await setMessageAnnotation(account.id, row.id, PLUGIN_ID, {
        queue, category: lines.category, ...(lines.spam ? { spam: lines.spam } : {}),
      });
      if (written.kind === 'written') reset += 1;
    }
    if (rows.length < PAGE) break;
    afterId = rows.at(-1).id;
  }
  res.json({ reset });
});

router.delete('/accounts/:id/incidents', async (req, res) => {
  const account = await ownedAccount(req, res);
  if (!account) return;
  await clearIncidents(account.id, req.session.userId);
  res.json({ incidents: [] });
});

export default router;
