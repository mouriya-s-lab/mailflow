// Accounts whose mail goes through an email-oauth2-proxy instance
// (https://github.com/mouriya-s-lab/vctcn-mail, emailproxy/control.py).
//
// One proxy instance per provider, reachable on the Stack's network under a
// fixed host name. The instance's host is the single fact that marks an
// account as a proxy account; MailFlow keeps oauth_provider set to the
// upstream provider (for its provider profile and Sent handling) with no
// OAuth tokens of its own: the proxy holds them, and MailFlow logs in to the
// proxy with the account's generated password.
import http from 'node:http';

export const PROXY_PROVIDERS = {
  microsoft: { host: 'emailproxy-microsoft' },
  google: { host: 'emailproxy-google' },
};
const CONTROL_PORT = 8080;
// Implicit TLS on both sides; the proxy's CA comes in through NODE_EXTRA_CA_CERTS.
export const PROXY_IMAP_PORT = 993;
export const PROXY_SMTP_PORT = 465;

// 'microsoft' | 'google' for a proxy account, null otherwise.
export function proxyProviderOf(account) {
  const host = (account?.imap_host || '').toLowerCase();
  for (const [provider, { host: proxyHost }] of Object.entries(PROXY_PROVIDERS)) {
    if (host === proxyHost) return provider;
  }
  return null;
}

// JSON call to a proxy instance's control API: resolves { status, body }.
export function controlRequest(provider, method, path, payload) {
  const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: PROXY_PROVIDERS[provider].host, port: CONTROL_PORT, method, path,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('email-oauth2-proxy control API timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// The connection of a proxy account is fixed by the flow that created it: its
// host, ports, TLS mode, login and generated password must not be edited.
// Other settings (name, colour, signature, …) stay editable. The settings form
// sends unchanged connection values back, so only actual changes are refused.
const LOCKED_FIELDS = ['imap_host', 'imap_port', 'smtp_host', 'smtp_port', 'smtp_tls', 'auth_user'];
const SECRET_FIELDS = ['auth_pass', 'smtp_auth_user', 'smtp_auth_pass'];
export function proxyAccountEditError(existing, updates) {
  if (!proxyProviderOf(existing)) return null;
  for (const field of LOCKED_FIELDS) {
    if (field in updates && String(updates[field]) !== String(existing[field])) {
      return `Cannot change ${field} of an account connected through the OAuth proxy; remove and add it again instead`;
    }
  }
  for (const field of SECRET_FIELDS) {
    if (updates[field]) {
      return 'Cannot set credentials of an account connected through the OAuth proxy';
    }
  }
  return null;
}

// Before a proxy account's row is deleted: stop its connection, then drop its
// tokens from the proxy. Returns an error message, or null to proceed.
export async function releaseProxyAccount(account, disconnect) {
  const provider = proxyProviderOf(account);
  if (!provider) return null;
  await disconnect();
  try {
    const { status } = await controlRequest(provider, 'DELETE', `/accounts/${encodeURIComponent(account.auth_user)}`);
    if (status === 204) return null;
    return `OAuth proxy refused to remove the account (HTTP ${status})`;
  } catch (err) {
    return `OAuth proxy unreachable: ${err.message}`;
  }
}
