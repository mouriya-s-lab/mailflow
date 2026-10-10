// "Add account → via OAuth proxy": MailFlow asks an email-oauth2-proxy
// instance to sign the mailbox in, shows the user the provider's consent link,
// takes back the address the browser landed on, and once the proxy holds the
// tokens creates an ordinary IMAP/SMTP account pointing at that instance.
//
//   POST   /api/accounts/proxy/start               { provider, email_address, name? }
//          -> { flow_id, permission_url, redirect_uri }
//   POST   /api/accounts/proxy/:flowId/complete    { response_url } -> account
//   DELETE /api/accounts/proxy/:flowId             cancel
//
// A flow lives only in this process's memory for the proxy's consent window.
// The generated password exists only here until the account row stores it
// (encrypted); a restart loses unfinished flows, and the user starts again.
// Tokens a lost flow may have left in the proxy are unusable without that
// password and are replaced by the next successful flow for the address.
import { randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { query } from '../src/services/db.js';
import { requireAuth } from '../src/middleware/auth.js';
import { createAccount } from '../src/routes/accounts.js';
import { PROXY_PROVIDERS, PROXY_IMAP_PORT, PROXY_SMTP_PORT, controlRequest } from './emailproxy.js';

const FLOW_TTL_MS = 11 * 60 * 1000; // proxy consent window (600 s) plus margin
const START_WAIT_MS = 20000;
const COMPLETE_WAIT_MS = 60000;
// Same shape the proxy accepts as an account name.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

const flows = new Map(); // flowId -> { userId, provider, email, name, password, controlFlowId, createdAt }

function sweep() {
  const now = Date.now();
  for (const [id, flow] of flows) if (now - flow.createdAt > FLOW_TTL_MS) flows.delete(id);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll the proxy flow until its state is one of `states` or the wait runs out.
async function waitForState(provider, controlFlowId, states, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, body } = await controlRequest(provider, 'GET', `/flows/${controlFlowId}`);
    if (status !== 200) return { state: 'failed', error: 'The OAuth proxy no longer knows this sign-in; start again' };
    if (states.includes(body.state) || Date.now() > deadline) return body;
    await sleep(500);
  }
}

// Drop a flow here and end its proxy-side wait, so the address can start again
// at once instead of being held for the proxy's consent window.
async function endFlow(flow) {
  flows.delete(flow.id);
  await controlRequest(flow.provider, 'DELETE', `/flows/${flow.controlFlowId}`).catch(() => {});
}

const router = Router();
router.use(requireAuth);

router.post('/start', async (req, res) => {
  sweep();
  const { provider, email_address: rawEmail, name } = req.body || {};
  if (!Object.hasOwn(PROXY_PROVIDERS, provider)) return res.status(400).json({ error: 'Unknown provider' });
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  const userId = req.session.userId;

  const existing = await query(
    'SELECT 1 FROM email_accounts WHERE user_id = $1 AND lower(email_address) = lower($2)', [userId, email]);
  if (existing.rows.length) return res.status(409).json({ error: 'This mailbox is already added' });
  // Starting again for the same address supersedes the earlier attempt.
  for (const flow of [...flows.values()]) {
    if (flow.userId === userId && flow.email.toLowerCase() === email.toLowerCase()) await endFlow(flow);
  }

  const password = randomBytes(24).toString('base64url');
  let started;
  try {
    started = await controlRequest(provider, 'POST', '/flows', { username: email, password });
  } catch (err) {
    return res.status(502).json({ error: `OAuth proxy unreachable: ${err.message}` });
  }
  if (started.status === 409) return res.status(409).json({ error: 'A sign-in for this mailbox is already in progress; finish it or wait for it to expire' });
  if (started.status !== 201) return res.status(502).json({ error: `OAuth proxy refused the sign-in (${started.body?.error || started.status})` });

  const controlFlowId = started.body.flow_id;
  const view = await waitForState(provider, controlFlowId, ['awaiting_response', 'authorised', 'failed'], START_WAIT_MS);
  if (view.state === 'failed') return res.status(502).json({ error: view.error || 'OAuth proxy sign-in failed' });
  if (view.state !== 'awaiting_response') {
    return res.status(502).json({ error: 'OAuth proxy did not produce a sign-in link' });
  }

  const id = randomUUID();
  flows.set(id, {
    id, userId, provider, email, password, controlFlowId, createdAt: Date.now(),
    name: typeof name === 'string' && name.trim() ? name.trim() : email,
  });
  res.json({ flow_id: id, permission_url: view.permission_url, redirect_uri: view.redirect_uri });
});

router.post('/:flowId/complete', async (req, res) => {
  sweep();
  const flow = flows.get(req.params.flowId);
  if (!flow || flow.userId !== req.session.userId) return res.status(404).json({ error: 'Sign-in expired; start again' });
  const responseUrl = req.body?.response_url;
  if (typeof responseUrl !== 'string' || !responseUrl.trim()) {
    return res.status(400).json({ error: 'Paste the full address from the browser after signing in' });
  }

  const sent = await controlRequest(flow.provider, 'POST', `/flows/${flow.controlFlowId}/response`, { response_url: responseUrl.trim() });
  if (sent.status === 400) {
    return res.status(400).json({ error: `That address does not start with ${sent.body?.redirect_uri}; copy the full address bar after signing in` });
  }
  if (sent.status !== 202) {
    flows.delete(flow.id);
    return res.status(409).json({ error: 'Sign-in expired; start again' });
  }

  const view = await waitForState(flow.provider, flow.controlFlowId, ['authorised', 'failed'], COMPLETE_WAIT_MS);
  if (view.state !== 'authorised') {
    flows.delete(flow.id);
    return res.status(400).json({ error: view.error || 'Sign-in did not complete in time; start again' });
  }

  const { host } = PROXY_PROVIDERS[flow.provider];
  const created = await createAccount(flow.userId, {
    name: flow.name, email_address: flow.email, protocol: 'imap',
    imap_host: host, imap_port: PROXY_IMAP_PORT,
    smtp_host: host, smtp_port: PROXY_SMTP_PORT, smtp_tls: 'SSL',
    auth_user: flow.email, auth_pass: flow.password,
    oauth_provider: flow.provider,
  });
  flows.delete(flow.id);
  if (!created.ok) {
    // Nothing references the tokens the proxy just stored; drop them.
    await controlRequest(flow.provider, 'DELETE', `/accounts/${encodeURIComponent(flow.email)}`).catch(() => {});
    return res.status(created.status).json({ error: created.error });
  }
  res.json(created.account);
});

router.delete('/:flowId', async (req, res) => {
  const flow = flows.get(req.params.flowId);
  if (flow && flow.userId === req.session.userId) await endFlow(flow);
  res.json({ ok: true });
});

export default router;
