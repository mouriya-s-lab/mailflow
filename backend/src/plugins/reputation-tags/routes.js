import { Router } from 'express';
import { requireAuth, getOwnedAccount, listUserAccounts, isPluginActivated, sourceStatus, countQueued } from '../api.js';
import { exclusive, loadBackfill, saveBackfill } from './records.js';
import { registerStoredResultRoutes } from './results.js';
import { startBackfill } from './backfill.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRoutes(plugin) {
  const router = Router();
  router.use(requireAuth);
  registerStoredResultRoutes(router, plugin);
  async function ownedAccount(req, res) {
    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid request', fields: { id: 'must be an account id' } });
      return null;
    }
    const account = await getOwnedAccount(req.session.userId, req.params.id);
    if (!account) res.status(404).json({ error: 'Account not found' });
    return account;
  }

  router.get('/status', async (req, res) => {
    const userId = req.session.userId;
    const [activated, source, accounts] = await Promise.all([
      isPluginActivated(userId, plugin.id), sourceStatus(plugin.source), listUserAccounts(userId),
    ]);
    const perAccount = await Promise.all(accounts.map(async account => {
      const [backfill, newMail, backfillQueue] = await Promise.all([
        loadBackfill(plugin.id, account.id),
        countQueued({ accountId: account.id, pluginId: plugin.id, origin: 'new_mail' }),
        countQueued({ accountId: account.id, pluginId: plugin.id, origin: 'backfill' }),
      ]);
      return { id: account.id, emailAddress: account.email_address, state: activated && source === 'enabled' ? 'enabled' : 'paused', backfill, queue: { new_mail: newMail, backfill: backfillQueue } };
    }));
    res.json({ activated, source, accounts: perAccount });
  });

  router.post('/accounts/:id/backfill', async (req, res) => {
    const account = await ownedAccount(req, res);
    if (!account) return;
    const outcome = await startBackfill(plugin, req.session.userId, account.id);
    switch (outcome.kind) {
      case 'started': return res.json({ backfill: outcome.backfill });
      case 'already_running': return res.status(409).json({ error: 'A backfill is already running', backfill: outcome.backfill });
      case 'skipped': return res.status(outcome.reason === 'account_missing' ? 404 : 409).json({ error: 'Backfill unavailable', reason: outcome.reason });
      default: throw new Error(`Unknown backfill outcome: ${outcome.kind}`);
    }
  });

  router.delete('/accounts/:id/backfill', async (req, res) => {
    const account = await ownedAccount(req, res);
    if (!account) return;
    const outcome = await exclusive(plugin.id, account.id, async () => {
      const run = await loadBackfill(plugin.id, account.id);
      if (run.kind !== 'running') return { stopped: false, run };
      const next = { ...run, kind: 'stopped', stoppedAt: new Date().toISOString() };
      await saveBackfill(plugin.id, account.id, req.session.userId, next);
      return { stopped: true, run: next };
    });
    if (!outcome.stopped) return res.status(409).json({ error: 'No backfill is running', backfill: outcome.run });
    res.json({ backfill: outcome.run });
  });
  return router;
}
