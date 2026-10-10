# Fork features (mouriya-s-lab/mailflow)

This fork adds features to upstream [maathimself/mailflow](https://github.com/maathimself/mailflow) that upstream does not carry. It is deployed on vctcn VM 183 together with the proxy control service from [mouriya-s-lab/vctcn-mail](https://github.com/mouriya-s-lab/vctcn-mail) ([pve-vctcn#325](https://github.com/mouriya-s-lab/pve-vctcn/issues/325)).

## Fork-wide changes

| File | Change |
|---|---|
| `backend/package.json` | `npm run lint` covers `fork-features` as well as `src`, so fork-only backend code is held to the same zero-warning lint as upstream code |

## CI and release

- GitHub Actions runs only upstream's `CI` (`.github/workflows/ci.yml`, unchanged) on pull requests and pushes to `main`. Upstream's `publish.yml`, `publish-apps.yml` and `sponsors.yml` are disabled in the repository's Actions settings: the fork publishes no GHCR images, desktop/mobile apps or sponsor charts. A workflow that arrives with an upstream sync starts enabled; disable it there unless the fork needs it.
- A push to `main` deploys itself: the homelab Komodo Action `mail-autodeploy` waits for that commit's `CI` run to succeed, then pulls the Komodo Repo `mailflow` and redeploys Stack `mail` ([pve-vctcn#329](https://github.com/mouriya-s-lab/pve-vctcn/issues/329)). A failed or missing `CI` run on `main` stops deployment and raises a Komodo alert, so `main` has to stay green.

## Mailboxes through email-oauth2-proxy

Adds a mailbox through an [email-oauth2-proxy](https://github.com/simonrob/email-oauth2-proxy) instance. Settings → Accounts → Add account offers "Sign in via OAuth proxy": the user picks Microsoft or Google and enters the address. MailFlow asks that provider's proxy instance for a consent link, the user signs in in their own browser and pastes back the address the browser landed on, and MailFlow then creates an ordinary IMAP/SMTP account that logs in to the proxy with a generated password. The proxy holds and refreshes the OAuth tokens.

### Fork-only code

| Path | What |
|---|---|
| `backend/fork-features/emailproxy.js` | Proxy hosts/ports, `proxyProviderOf(account)`, control API client, edit guard, delete cleanup |
| `backend/fork-features/emailproxyAccounts.js` | `/api/accounts/proxy` routes: start, complete, cancel |
| `frontend/fork-features/ProxyAccountForm.jsx` | Add-account mode switch and the proxy sign-in form |
| `frontend/fork-features/api.js` | Proxy-only start, complete and cancel API calls |
| `frontend/fork-features/ProxyAccountForm.render.test.js` | Render test of the form |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/routes/accounts.js` | `POST /` body extracted to exported `createAccount(userId, fields)`; PUT refuses connection edits of proxy accounts; DELETE releases the proxy account before deleting the row |
| `backend/src/index.js` | Mounts the proxy router before the generic accounts router |
| `backend/src/services/smtpTransport.js` | Skips token refresh for proxy accounts (they carry `oauth_provider` but no tokens) |
| `backend/src/services/imapManager.js` | `providerProfile` gives proxy Google accounts the Google profile |
| `backend/src/services/diagnosticsReport.js` | Reports proxy accounts' auth type as `emailproxy` |
| `backend/Dockerfile` | Copies `backend/fork-features` into the image |
| `frontend/src/components/AdminPanel.jsx` | Add-account view uses `AddAccountView` |
| `frontend/src/locales/*.json` | `admin.accounts.proxy.*` strings |
| `backend/src/routes/accounts.autoRecipients.test.js`, `backend/src/services/smtpTransport.test.js` | Ownership-query mock; proxy SMTP regression test |

### Deployment requirements

- Proxy instances reachable as `emailproxy-microsoft` and `emailproxy-google` on the backend's network, IMAPS 993 and SMTPS 465 (implicit TLS), control API on 8080.
- The proxies' CA certificate passed to the backend with `NODE_EXTRA_CA_CERTS`.
- Admin setting "Allow private / local hosts" on, since the proxy hosts resolve to private addresses.

### Model

A proxy account is identified by its IMAP host alone. It keeps `oauth_provider` = `microsoft` or `google` so provider-specific behaviour (folder profile, server-side Sent copies) applies, with no OAuth tokens of its own. Sign-in flows live in backend memory for the proxy's 10-minute consent window; a restart drops unfinished ones.

On upstream sync: if upstream gains a hook for alternative account sources or provider auth, move this feature onto it and drop the corresponding patches.

## Jev client

A generic client for the [Jev](https://jev-ai.org/docs/) decision API: one state string and a set of questions go out, typed answers or a typed error come back. It carries no mail semantics; deciding what to ask about a message is the caller's job. Plugins reach it through the plugin API as `jevDecide` and `jevStatus`.

- `decide({ state, questions }, { signal?, deadlineMs? })` resolves to `{ kind: 'ok', answers, model, inputTokens }` or `{ kind: 'error', error }`. A question is `{ kind: 'noul', instructions }`, `{ kind: 'choice', instructions, criteria: { label: description } }` (2–24 labels) or `{ kind: 'score', instructions, criteria: [tier, …] }` (2–10 tiers, low to high); `state` is a string, so callers serialize objects themselves. Answers come back as `{ kind: 'noul', probability }`, `{ kind: 'choice', choice, confidence, probabilities }` or `{ kind: 'score', score, confidence, probabilities, legend }`.
- Errors: `unconfigured`, `invalid_request { detail }` (the questions failed validation; nothing was sent), `http { status }`, `rate_limited { retryAfterMs }` (429, `Retry-After` in milliseconds or `null`), `timeout`, `aborted` (the caller's `signal`), `network`, `invalid_response { detail }` (not JSON, over 1 MiB, or any answer missing, extra, of the wrong type or out of range).
- The deadline is 30 seconds; `deadlineMs` can only shorten it. Nothing is retried; retrying belongs to the caller's own persistent state.
- `status()` is `{ kind: 'configured', baseUrl, model }` or `{ kind: 'unconfigured' }`.
- Configuration comes only from the environment, read on every call: `JEV_API_KEY` (unset or empty means unconfigured), `JEV_BASE_URL` (default `https://api.commandcode.ai/provider/v1/systemone`), `JEV_MODEL` (default `typesafe/jev`).
- Failures from the endpoint (`http`, `rate_limited`, `timeout`, `network`, `invalid_response`) are logged with `logger.warn`, at most one line per error kind per minute, carrying the count of failures suppressed since the previous line. Log lines and error objects never contain the state or the key.

| Path | What |
|---|---|
| `backend/fork-features/jev/index.js` | `decide`, `status`: request validation, HTTP call, response parsing |
| `backend/fork-features/jev/index.test.js` | Tests against a local HTTP server |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/plugins/api.js` | Exports `jevDecide` and `jevStatus` from `fork-features/jev` |
| `backend/src/plugins/README.md` | Lists `jevDecide` and `jevStatus` in the capability surface |

## Jev probe

A command-line probe that builds the Jev decision state from MailFlow message-shaped fixtures and sends it through the Jev client twice, once with the full structured state (sender, reply-to, trusted authentication results, language, links as shown versus where they go, attachments, mailing-list signals) and once with subject and body only, then prints the answers side by side. It needs no running MailFlow.

```bash
cd backend
JEV_API_KEY=… node fork-features/jev-probe/probe.js [--fixtures DIR] [--questions FILE] [--mode full|body|both] [--print-state]
```

The endpoint, model and key come from the Jev client's environment variables above. A questions file maps question ids to questions in the Jev client's shape. A fixture is one JSON file shaped like a `messages` row plus `headers` (raw header lines) and `trusted_authserv_id`; `Authentication-Results` counts as trusted only when its authserv-id matches it.

| Path | What |
|---|---|
| `backend/fork-features/jev-probe/probe.js` | State builder and comparison table; requests go through the Jev client |
| `backend/fork-features/jev-probe/questions.json` | Default question set: spam (noul), category (choice), urgency (score) |
| `backend/fork-features/jev-probe/fixtures/*.json` | Sample messages |
