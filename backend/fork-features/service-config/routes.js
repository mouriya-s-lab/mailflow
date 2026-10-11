// Admin endpoints for the external service configuration (./index.js), mounted at /api/admin/fork.
//
//   GET /jev          -> { config: { baseUrl, model, apiKey: mask | '' } }
//   PUT /jev          { baseUrl, model, apiKey } -> { ok, config }
//   GET /reputation   -> { config: { rdapEnabled, spamhausDqsKey, urlhausAuthKey, safeBrowsingApiKey } }
//   PUT /reputation   { rdapEnabled, spamhausDqsKey, urlhausAuthKey, safeBrowsingApiKey } -> { ok, config }
import { Router } from 'express';
import { requireAdmin } from '../../src/middleware/auth.js';
import {
  getAdminJevConfig,
  getAdminReputationConfig,
  saveJevConfig,
  saveReputationConfig,
} from './index.js';

const router = Router();
router.use(requireAdmin);

function respond(req, res, result, service) {
  switch (result.kind) {
    case 'saved':
      console.log(`[admin] ${req.session.username} updated ${service} config`);
      return res.json({ ok: true, config: result.config });
    case 'invalid':
      return res.status(400).json({ error: result.error });
    default:
      throw new Error(`unhandled save result ${result.kind}`);
  }
}

router.get('/jev', async (_req, res) => {
  res.json({ config: await getAdminJevConfig() });
});

router.put('/jev', async (req, res) => {
  respond(req, res, await saveJevConfig(req.body), 'Jev');
});

router.get('/reputation', async (_req, res) => {
  res.json({ config: await getAdminReputationConfig() });
});

router.put('/reputation', async (req, res) => {
  respond(req, res, await saveReputationConfig(req.body), 'link reputation');
});

export default router;
