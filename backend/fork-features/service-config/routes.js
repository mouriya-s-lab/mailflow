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
  testJevConfig,
  testReputationKeys,
} from './index.js';
import { decide } from '../jev/index.js';
import { testReputationSource } from '../reputation/index.js';

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

// A fixed question for the Jev connection test. Any well-formed answer shows that the endpoint, the
// key and the model work; the answer itself is discarded.
const JEV_TEST = {
  state: 'MailFlow connection test. This message is a test with no content.',
  questions: { connection: { kind: 'noul', instructions: 'Answer whether this test message is spam.' } },
};

const KEYED_SOURCES = [
  ['spamhaus_dbl', 'spamhausDqsKey'],
  ['urlhaus', 'urlhausAuthKey'],
  ['safe_browsing', 'safeBrowsingApiKey'],
];

// Tests run with the form's values, saved or not, and write nothing. A refused test is a 200 result;
// only a request the server cannot read is a 400. No key is ever in a response.
router.post('/jev/test', async (req, res) => {
  const config = await testJevConfig(req.body);
  if (config.kind === 'invalid') return res.status(400).json({ error: config.error });
  const result = await decide(config.value, JEV_TEST);
  if (result.kind === 'ok') return res.json({ ok: true });
  const { kind, status } = result.error;
  return res.json({ ok: false, reason: kind, status: kind === 'http' ? status : null });
});

router.post('/reputation/test', async (req, res) => {
  const keys = await testReputationKeys(req.body);
  if (keys.kind === 'invalid') return res.status(400).json({ error: keys.error });
  const results = await Promise.all(KEYED_SOURCES.map(async ([source, field]) => {
    const key = keys.value[field];
    return [source, key ? await testReputationSource(source, key) : { kind: 'unconfigured' }];
  }));
  res.json({ results: Object.fromEntries(results) });
});

export default router;
