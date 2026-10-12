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
| `frontend/fork-features/api.js` | `proxyApi`: start, complete and cancel API calls |
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

## External service settings

Administrators configure the outside services the fork's mail features use in Settings → Administration → External services, and MailFlow keeps that configuration in its database; nothing about these services is set through the environment or the deployment. Two blocks:

- **Jev**: endpoint URL and model, prefilled with `https://api.commandcode.ai/provider/v1/systemone` and `typesafe/jev`, and the API key. Without a key Jev is unconfigured.
- **Link reputation**: whether RDAP registration lookups run (on by default) and optional keys for Spamhaus DQS, URLhaus and Google Safe Browsing. A source without a key is unconfigured.

Storage follows the AI provider's `ai_config`: one `system_settings` row per service, `fork_jev_config` (`{ baseUrl, model, apiKey }`) and `fork_reputation_config` (`{ rdapEnabled, spamhausDqsKey, urlhausAuthKey, safeBrowsingApiKey }`), with every key encrypted by `encrypt()` and `null` when absent. Both are read from the database on every use, so a change applies to the next call without a restart, and there is no cache.

- Admin endpoints, all behind `requireAdmin`: `GET`/`PUT /api/admin/fork/jev` and `GET`/`PUT /api/admin/fork/reputation`. A `PUT` carries the whole configuration. Responses show a stored key as the mask `••••••••` and an absent one as `''`; in a request the mask keeps the stored key, an empty string removes it, and anything else replaces it. The Jev endpoint URL must be http(s) and pass the same host check as the AI provider's base URL ("Allow private / local hosts" applies). An invalid body is a 400 with the reason and writes nothing. Saving logs only which admin changed which service.
- `loadJevConfig()` returns `{ baseUrl, model, apiKey }` with the key decrypted or `null`; the plugin API's `jevDecide` and `jevStatus` read it on every call. `getReputationConfig()` returns `{ rdapEnabled, spamhausDqsKey, urlhausAuthKey, safeBrowsingApiKey }` with keys decrypted or `null`, for the reputation module.
- A stored key that no longer decrypts (`ENCRYPTION_KEY` changed) makes both loaders throw instead of reading as "no key"; the admin page still shows the key as set, so set it again there.

| Path | What |
|---|---|
| `backend/fork-features/service-config/index.js` | Load, mask, validate and save both configurations |
| `backend/fork-features/service-config/routes.js` | The `/api/admin/fork` endpoints |
| `backend/fork-features/service-config/*.test.js` | Storage, masking and key semantics; admin-only access and responses without keys |
| `frontend/fork-features/ExternalServicesTab.jsx` | The settings tab with the Jev and link reputation blocks |
| `frontend/fork-features/api.js` | `serviceConfigApi` calls |
| `frontend/fork-features/ExternalServicesTab.render.test.js` | Render test: mask kept, key cleared, RDAP switch sent |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/index.js` | Mounts the `/api/admin/fork` router before the generic admin router |
| `frontend/src/components/AdminPanel.jsx` | Admin-only `external-services` tab in the Administration group, its render line and two search entries |
| `frontend/src/locales/*.json` | `admin.tabs.externalServices` and `admin.externalServices.*` strings |
| `frontend/src/locales/i18n.test.js` | `SAME_VALUE_ALLOWED` entries for the `admin.externalServices.*` strings that are product names or the same word across languages |

## Jev client

A generic client for the [Jev](https://jev-ai.org/docs/) decision API: one state string and a set of questions go out, typed answers or a typed error come back. It carries no mail semantics; deciding what to ask about a message is the caller's job. Plugins reach it through the plugin API as `jevDecide` and `jevStatus`.

- `decide(config, { state, questions }, { signal?, deadlineMs? })` resolves to `{ kind: 'ok', answers, model, inputTokens }` or `{ kind: 'error', error }`. `config` is `{ baseUrl, model, apiKey }`, passed by the caller on every call; the client reads no environment. A question is `{ kind: 'noul', instructions }`, `{ kind: 'choice', instructions, criteria: { label: description } }` (2–24 labels) or `{ kind: 'score', instructions, criteria: [tier, …] }` (2–10 tiers, low to high); `state` is a string, so callers serialize objects themselves. Answers come back as `{ kind: 'noul', probability }`, `{ kind: 'choice', choice, confidence, probabilities }` or `{ kind: 'score', score, confidence, probabilities, legend }`.
- Errors: `unconfigured` (`apiKey` is null or empty; nothing was sent), `invalid_request { detail }` (the questions failed validation; nothing was sent), `http { status }`, `rate_limited { retryAfterMs }` (429, `Retry-After` in milliseconds or `null`), `timeout`, `aborted` (the caller's `signal`), `network`, `invalid_response { detail }` (not JSON, over 1 MiB, or any answer missing, extra, of the wrong type or out of range).
- The deadline is 30 seconds; `deadlineMs` can only shorten it. Nothing is retried; retrying belongs to the caller's own persistent state.
- `status(config)` is `{ kind: 'configured', baseUrl, model }` or `{ kind: 'unconfigured' }`. `JEV_DEFAULTS` holds the default endpoint and model.
- Inside MailFlow the configuration is the admin setting above: the plugin API's `jevDecide(request, options)` and `jevStatus()` load it with `loadJevConfig()` on every call, so both return promises.
- Failures from the endpoint (`http`, `rate_limited`, `timeout`, `network`, `invalid_response`) are logged with `logger.warn`, at most one line per error kind per minute, carrying the count of failures suppressed since the previous line. Log lines and error objects never contain the state or the key.

| Path | What |
|---|---|
| `backend/fork-features/jev/index.js` | `decide`, `status`: request validation, HTTP call, response parsing |
| `backend/fork-features/jev/index.test.js` | Tests against a local HTTP server |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/plugins/api.js` | `jevDecide` and `jevStatus`: `fork-features/jev` with the configuration from `fork-features/service-config` |
| `backend/src/plugins/README.md` | Lists `jevDecide` and `jevStatus` in the capability surface |

## Jev probe

A command-line probe that builds the Jev decision state from MailFlow message-shaped fixtures and sends it through the Jev client twice, once with the full structured state (sender, reply-to, trusted authentication results, language, links as shown versus where they go, attachments, mailing-list signals) and once with subject and body only, then prints the answers side by side. It needs no running MailFlow.

```bash
cd backend
JEV_API_KEY=… node fork-features/jev-probe/probe.js [--fixtures DIR] [--questions FILE] [--mode full|body|both] [--print-state]
```

The probe runs outside MailFlow, so it builds the Jev client's configuration from its own command-line environment: `JEV_API_KEY` (required), `JEV_BASE_URL` and `JEV_MODEL` (defaulting to the client's defaults). A questions file maps question ids to questions in the Jev client's shape. A fixture is one JSON file shaped like a `messages` row plus `headers` (raw header lines) and `trusted_authserv_id`; `Authentication-Results` counts as trusted only when its authserv-id matches it.

| Path | What |
|---|---|
| `backend/fork-features/jev-probe/probe.js` | State builder and comparison table; requests go through the Jev client |
| `backend/fork-features/jev-probe/questions.json` | Default question set: spam (noul), category (choice), urgency (score) |
| `backend/fork-features/jev-probe/fixtures/*.json` | Sample messages |

## Registrable domains

Every "which registrable domain does this host belong to" decision goes through the Public Suffix List, using the [`tldts`](https://github.com/remusao/tldts) package with private suffixes included. So `shop.com.cn` and `scam.com.cn` are different domains, and each site under `github.io` or `blogspot.com` is its own domain rather than all of them sharing `github.io`.

- `registrableDomain(host)` lowercases the host, drops one trailing dot, converts an IDN to punycode and returns its registrable domain: `mail.shop.com.cn` → `shop.com.cn`, `evil.github.io` → `evil.github.io`, `例子.中国` → `xn--fsqu00a.xn--fiqs8s`. An IP address, `localhost`, an invalid host, or a host that is itself a public suffix (`com.cn`, `github.io`) gives `null`.
- `hostOfUrl(url)` returns the host of an absolute `http:` or `https:` URL, without a trailing dot, and `null` for any other scheme (`javascript:`, `mailto:`), a relative reference or a string that does not parse.
- The anti-spam rule `FROM_REPLYTO_MISMATCH` compares the registrable domains of From and Reply-To. The sender-icon lookup walks a subdomain that has no icon up one label at a time and stops at its registrable domain, so it never asks for a public suffix such as `co.uk`.

| Path | What |
|---|---|
| `backend/fork-features/domains/index.js` | `registrableDomain`, `hostOfUrl` |
| `backend/fork-features/domains/index.test.js` | Expected domains and `null` cases for both functions |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/package.json`, `backend/package-lock.json` | `tldts` dependency |
| `backend/src/services/spamRules.js` | `FROM_REPLYTO_MISMATCH` uses `registrableDomain`; the hand-written multi-label suffix list and its local helper are removed |
| `backend/src/services/senderFavicon.js` | The parent walk (`nextParent`) stops at `registrableDomain`; the hand-written public suffix list is removed |
| `backend/src/services/spamRules.test.js`, `backend/src/services/senderFavicon.test.js` | Cases for `com.cn`, `net.cn`, a deep `co.uk` subdomain and `github.io` |

## Message header retention

Some headers say things nothing else in a stored message does: who authenticated the sender (`Authentication-Results`, `ARC-Authentication-Results`, `Received-SPF`), which language the sender declared (`Content-Language`), and the original `From`, `Sender`, `Reply-To`, `Return-Path`, `List-Id` and `Subject`. They exist only while a message is being ingested, so MailFlow keeps that whitelist of headers for every message in `fork_message_headers`, one row per `messages` row.

- **At ingest.** `syncMessages` and `backfillMessages` already fetch each message's header block. After every successful upsert of a row, new or existing, its whitelisted headers are inserted with `source = 'ingest'`; a row that already has a record keeps it. Values are the parser's strings: folded lines unfolded, a repeated header joined with `\n`, NUL removed; no header outside the whitelist is stored. A failed insert is a `logger.warn` and nothing else: the message keeps its row and the batch goes on. A message fetched without a header block (the backfill's fallback FETCH for messages a server omitted asks for none) gets no record rather than an empty one.
- **On demand.** `getMessageHeaders(messageIds, { deadlineMs })` resolves to a `Map` from row id to `{ kind: 'stored', headers, source }` or `{ kind: 'unavailable', reason }` with `reason` `message_missing`, `imap_error` or `not_on_server`. Rows without a record (mail ingested before this table existed, or a row a move recreated under a new id) are grouped by account and folder, and each group is one IMAP session and one `UID FETCH <uids> (BODY.PEEK[HEADER.FIELDS (...)])` of the whitelist; what was fetched is stored with `source = 'imap_fetch'` and read back, so a later call does not touch IMAP. Groups run one after another; the deadline (30 s by default, `deadlineMs` can only shorten it) is checked before each group, and a group not started in time is `imap_error`. Concurrent reads of the same message share one fetch.
- **Nothing is written for a message that could not be read**, and each failure is a `logger.warn`: a server that cannot be reached or fails the FETCH is `imap_error`, as is an empty header block in the answer; a UID the server does not return is `not_on_server`, and so is every row of a folder whose UIDVALIDITY on the server differs from the stored one, since those rows are stale and their UIDs may name other messages. Database errors are thrown to the caller.
- **Lifecycle.** A record is deleted with its row (`ON DELETE CASCADE`). A move that keeps the row id keeps the record; one that replaces the row leaves the new row without a record until its next read. Backups treat the table as part of the mail cache, next to `messages`.

| Path | What |
|---|---|
| `backend/migrations/9001_fork_message_headers.sql` | The `fork_message_headers` table; creates a new table only |
| `backend/fork-features/headers/index.js` | Whitelist, `storedHeaders`, `recordIngestHeaders`, `getMessageHeaders` |
| `backend/fork-features/headers/index.test.js` | Stored values; one session and one FETCH per group, compiled through imapflow to the wire command; single-flight; failure results |
| `backend/fork-features/headers/ingest.test.js` | Capture from live sync and backfill, a failed write, a message fetched without headers |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/services/imapManager.js` | `syncMessages` and `backfillMessages` call `recordIngestHeaders` after each upsert; new `fetchHeaderFields(account, folder, uids, fields)` reads header fields for a UID set over one pooled session |
| `backend/src/services/backup.js` | `fork_message_headers` is in `MAIL_CACHE_TABLES` |

## Link reputation

What the links in a message point to, judged by outside lookup services without ever opening a link: when a domain was registered (RDAP), whether Spamhaus DBL or URLhaus list it, and whether Google Safe Browsing lists a link's URL. Plugins reach it through the plugin API as `lookupDomainReputation`, `lookupUrlReputation` and `reputationStatus`. Whether RDAP runs and the keys of the other three sources are the link reputation block of the external service settings above, read on every call.

- `lookupDomains(domains, { deadlineMs })` takes registrable domains as `registrableDomain` returns them (anything else throws) and resolves to a `Map` from each domain to `{ registration, listings: { spamhaus_dbl, urlhaus } }`. `registration` is `{ kind: 'known', registeredAt }` (ISO 8601), `{ kind: 'not_found' }`, or `{ kind: 'unknown', reason }` with `reason` `timeout`, `rate_limited`, `error`, `unsupported_tld` (IANA's bootstrap names no RDAP service for the TLD) or `disabled` (RDAP is switched off).
- `lookupUrls(urls, { deadlineMs })` takes absolute http(s) URLs and resolves to a `Map` from each URL to `{ safe_browsing }`. It is a verdict on that URL, not on its domain.
- A listing is `{ kind: 'listed', detail }`, `{ kind: 'not_listed' }`, `{ kind: 'unknown', reason }` (`timeout`, `rate_limited`, `error`) or `{ kind: 'unconfigured' }` (no key). There is no "clean": `not_listed` says only that this source has no listing.
- `status()` resolves to `{ rdap, spamhaus_dbl, urlhaus, safe_browsing }`, each `enabled` or `unconfigured`, and RDAP `disabled` when switched off. It reads the settings and nothing else.
- `deadlineMs` bounds the whole lookup from the call, and each request also stops after 5 seconds. At most 4 RDAP, 8 DBL, 4 URLhaus and 2 Safe Browsing requests run at once across all callers; one that cannot start before the deadline is not sent and is `unknown { timeout }`.

| Source | Request | Kept for |
|---|---|---|
| RDAP | `GET <base>domain/<domain>` at the registry that IANA's bootstrap (`https://data.iana.org/rdap/dns.json`) names for the TLD; the date of the first `registration` event. 404 is `not_found`; a 200 without a registration date is `unknown { error }` | `known` 30 days, `not_found` 1 day |
| Spamhaus DBL | DNS `A` query for `<domain>.<DQS key>.dbl.dq.spamhaus.net` through the system's resolver. `127.0.1.2`–`127.0.1.199` is a listing; `NXDOMAIN` or no `A` record is not listed; `127.255.255.255` is `rate_limited`; any other answer is an error | a listing for the answer's TTL; not listed for the negative TTL of the SOA in the answer (the lesser of its TTL and MINIMUM), and not at all without one |
| URLhaus | `POST https://urlhaus-api.abuse.ch/v1/host/` with `host=<domain>` and the `Auth-Key` header; `query_status` `ok` is a listing, `no_results` not listed | 1 hour |
| Safe Browsing | `GET https://safebrowsing.googleapis.com/v5/hashes:search` with the key in `X-Goog-Api-Key` and nothing but the 4-byte SHA-256 prefixes of the URL's host-suffix/path-prefix expressions, formed as Google's "URLs and Hashing" describes; the full hashes that come back are matched here. A threat detail with an unknown threat type or with any attribute (`CANARY`, `FRAME_ONLY`) is ignored | the response's `cacheDuration`, but a listing is reported from the cache only while it is under 30 minutes old and asked again after that |

- **Failures.** Every failure of an outside service is `unknown`, and a `logger.warn` of at most one line per source per minute that counts the failures it held back. A line names the source and the kind of failure, never a domain, URL or key. `unconfigured` and `disabled` are states shown by `status()`, not logged.
- **Cache.** `fork_reputation_cache` holds one row per source and subject (the domain, or for Safe Browsing the canonical URL without its scheme) with `fetched_at` and `expires_at`. It is a copy of what the services answered, global rather than per user since a verdict is about a domain, and read only through these functions. `unknown` answers, `unsupported_tld` included, are never stored, so the next lookup asks again. A source that is switched off or has no key neither reads the cache nor sends anything. An expired row stays until its subject is looked up again and the new answer replaces it. Backups leave the table out, as they do the short-lived tokens.
- **Bootstrap.** IANA's bootstrap file is kept in memory for a day after it was fetched. A failed fetch is not kept: every RDAP answer of that lookup is `unknown`, and the next lookup fetches again.
- **Transport.** The HTTP sources go through `safeFetch`, which checks every connection and redirect against private addresses. A response over 1 MiB is an error.

| Path | What |
|---|---|
| `backend/migrations/9002_fork_reputation_cache.sql` | The `fork_reputation_cache` table; creates a new table only |
| `backend/fork-features/reputation/index.js` | `lookupDomains`, `lookupUrls`, `status`: the four sources, limits and the cache |
| `backend/fork-features/reputation/dnsQuery.js` | One DNS `A` query over UDP, returning the negative TTL Node's resolver does not report; a datagram with another id or question is ignored, a truncated or malformed one is an error |
| `backend/fork-features/reputation/dnsQuery.test.js` | Response parsing and the UDP exchange: TTLs, negative TTL, stray and malformed datagrams, no answer |
| `backend/fork-features/reputation/safeBrowsing.js` | URL canonicalization and expressions for Safe Browsing |
| `backend/fork-features/reputation/index.test.js` | Each source against local stand-ins (HTTP servers and a UDP resolver): verdicts, failures, cache lifetimes, warnings, and exactly what is sent |
| `backend/fork-features/reputation/index.postgres.test.js` | The migration and the cache statements on PostgreSQL, rolled back; runs when `MAILFLOW_TEST_DATABASE_URL` is set |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/plugins/api.js` | `lookupDomainReputation`, `lookupUrlReputation` and `reputationStatus` from `fork-features/reputation` |
| `backend/src/plugins/README.md` | Lists them in the capability surface |
| `backend/src/services/backup.js` | `fork_reputation_cache` is in `TRANSIENT_TABLES`, whose comment now covers caches of outside lookups |
