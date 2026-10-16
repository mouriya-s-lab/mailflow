# Fork features (mouriya-s-lab/mailflow)

This fork adds features to upstream [maathimself/mailflow](https://github.com/maathimself/mailflow) that upstream does not carry. It is deployed on vctcn VM 183 together with the proxy control service from [mouriya-s-lab/vctcn-mail](https://github.com/mouriya-s-lab/vctcn-mail) ([pve-vctcn#325](https://github.com/mouriya-s-lab/pve-vctcn/issues/325)).

## Fork-wide changes

| File | Change |
|---|---|
| `backend/package.json` | `npm run lint` covers `fork-features` as well as `src`, so fork-only backend code is held to the same zero-warning lint as upstream code |
| `frontend/src/components/AdminPanel.jsx` | One settings content subtree survives the mobile/desktop layout switch, so rotating a phone does not discard fork form drafts, proxy sign-in state or an open stored-results panel |

### Mobile web UI

Fork settings use the existing `useMobile()` breakpoint (below 768 CSS pixels), without
changing API requests or maintaining separate mobile state. OAuth proxy and external-service
forms, Jev category/routing editors and reputation backfill controls keep their existing
component instances. Mobile inputs use 16px text, action targets allow at least 44px of
height, and long addresses, paths and diagnostics wrap instead of pushing controls off-screen.

Stored plugin results render every desktop field and both actions in vertically arranged
mobile records; desktop retains the table. Account/facet filters, counts, cursor pagination,
expanded observations and exact physical-message navigation share the same state in both
layouts. Jev queue matrices, move incidents and anti-spam language partitions likewise keep
every value in labelled mobile records. The spam explanation dialog wraps long evidence and
keeps its Close control reachable while scrolling. Mail-list tags and all-source reading
details remain available; the shared reading header wraps long sender and account identities
without letting account metadata consume the sender's width. Desktop-only detached windows
are not a mobile navigation path.

On upstream sync, preserve the single settings content subtree as well as the individual
layouts. The render regressions in `frontend/src/components/AdminPanel.render.test.js` and
`frontend/fork-features/plugin-results/PluginResultsPanel.render.test.js` cover draft and
expanded-result retention across the breakpoint. Actual browser checks must also exercise
320px, 390px, 767px and desktop widths, including long content and real saves/actions; JSDOM
does not establish control geometry or absence of horizontal clipping.

## CI and release

- GitHub Actions runs only upstream's `CI` (`.github/workflows/ci.yml`, unchanged) on pull requests and pushes to `main`. Upstream's `publish.yml`, `publish-apps.yml` and `sponsors.yml` are disabled in the repository's Actions settings: the fork publishes no GHCR images, desktop/mobile apps or sponsor charts. A workflow that arrives with an upstream sync starts enabled; disable it there unless the fork needs it.
- A push to `main` deploys itself: the homelab Komodo Action `mail-autodeploy` waits for that commit's `CI` run to succeed, then pulls the Komodo Repo `mailflow` and redeploys Stack `mail` ([pve-vctcn#329](https://github.com/mouriya-s-lab/pve-vctcn/issues/329)). A failed or missing `CI` run on `main` stops deployment and raises a Komodo alert, so `main` has to stay green.
- The backend dependency stage installs for the target platform, as does its runtime stage. `@xberg-io/html-to-markdown` loads a platform/libc-specific native binding; installing dependencies on `$BUILDPLATFORM` and copying them into another target architecture can produce an image whose converter cannot load.

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

A command-line probe that builds the Jev decision state from MailFlow message-shaped fixtures and sends it through the Jev client twice, once with the full structured state (the message signals below plus the cleaned Markdown body) and once with subject and body only, then prints the answers side by side. It needs no running MailFlow. Both modes use the same `messageBodyMarkdown` conversion as classification; the probe retains its own 20,000-character comparison limit and question set, so it is not a replay of a production classification request.

```bash
cd backend
JEV_API_KEY=… node fork-features/jev-probe/probe.js [--fixtures DIR] [--questions FILE] [--mode full|body|both] [--print-state]
```

The probe runs outside MailFlow, so it builds the Jev client's configuration from its own command-line environment: `JEV_API_KEY` (required), `JEV_BASE_URL` and `JEV_MODEL` (defaulting to the client's defaults). A questions file maps question ids to questions in the Jev client's shape. A fixture is one JSON file holding the input of `extractSignals`: `message` (a `messages` row), `headers` (a header read result as `getMessageHeaders` returns it) and `account` (`trusted_authserv_id`). The state is built by the signals module; the probe has no parsing of its own.

| Path | What |
|---|---|
| `backend/fork-features/jev-probe/probe.js` | Comparison table; the state comes from `fork-features/signals` and requests go through the Jev client |
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

What the links in a message point to, judged by outside lookup services without ever opening a link: when a domain was registered (RDAP), whether Spamhaus DBL or URLhaus list it, and whether Google Safe Browsing lists a link's URL. Each source has its own lookup function, which asks only that source's service and reads and writes only that source's cache rows; plugins reach these capabilities through the plugin API under the same names. Whether RDAP runs and the keys of the other three sources are the link reputation block of the external service settings above, read on every call.

- `lookupRdap(domains, { deadlineMs })` takes registrable domains as `registrableDomain` returns them (anything else throws) and resolves to a `Map` from each domain to its registration: `{ kind: 'known', registeredAt }` (ISO 8601), `{ kind: 'not_found' }`, or `{ kind: 'unknown', reason }` with `reason` `timeout`, `rate_limited`, `error`, `unsupported_tld` (IANA's bootstrap names no RDAP service for the TLD) or `disabled` (RDAP is switched off).
- `lookupSpamhausDbl(domains, { deadlineMs })` and `lookupUrlhaus(domains, { deadlineMs })` take registrable domains the same way and resolve to a `Map` from each domain to that source's listing.
- `lookupSafeBrowsing(urls, { deadlineMs })` takes absolute http(s) URLs and resolves to a `Map` from each URL to its listing. It is a verdict on that URL, not on its domain.
- A listing is `{ kind: 'listed', detail }`, `{ kind: 'not_listed' }`, `{ kind: 'unknown', reason }` (`timeout`, `rate_limited`, `error`) or `{ kind: 'unconfigured' }` (no key). There is no "clean": `not_listed` says only that this source has no listing.
- `sourceStatus(source)`, with `source` one of `rdap`, `spamhaus_dbl`, `urlhaus`, `safe_browsing`, resolves to `enabled` or `unconfigured`, and for RDAP `enabled` or `disabled` (switched off). It reads the settings and nothing else; any other `source` throws.
- `reputationUrlSubject(url)` is pure and returns `{ urlDigest, host }`: the lowercase hexadecimal SHA-256 of exactly the canonical subject Safe Browsing uses for its cache, and the link host. Invalid or non-http(s) inputs throw `TypeError`; it reads no setting and sends no request.
- `deadlineMs` bounds the whole lookup from the call, and each request also stops after 5 seconds. At most 4 RDAP, 8 DBL, 4 URLhaus and 2 Safe Browsing requests run at once across all callers; one that cannot start before the deadline is not sent and is `unknown { timeout }`. A caller that needs several sources asks their functions side by side, each with its own deadline.

| Source | Request | Kept for |
|---|---|---|
| RDAP | `GET <base>domain/<domain>` at the registry that IANA's bootstrap (`https://data.iana.org/rdap/dns.json`) names for the TLD; the date of the first `registration` event. 404 is `not_found`; a 200 without a registration date is `unknown { error }` | `known` 30 days, `not_found` 1 day |
| Spamhaus DBL | DNS `A` query for `<domain>.<DQS key>.dbl.dq.spamhaus.net` through the system's resolver. `127.0.1.2`–`127.0.1.199` is a listing; `NXDOMAIN` or no `A` record is not listed; `127.255.255.255` is `rate_limited`; any other answer is an error | a listing for the answer's TTL; not listed for the negative TTL of the SOA in the answer (the lesser of its TTL and MINIMUM), and not at all without one |
| URLhaus | `POST https://urlhaus-api.abuse.ch/v1/host/` with `host=<domain>` and the `Auth-Key` header; `query_status` `ok` is a listing, `no_results` not listed | 1 hour |
| Safe Browsing | `GET https://safebrowsing.googleapis.com/v5/hashes:search` with the key in `X-Goog-Api-Key` and nothing but the 4-byte SHA-256 prefixes of the URL's host-suffix/path-prefix expressions, formed as Google's "URLs and Hashing" describes; the full hashes that come back are matched here. The [HTTP API returns protobuf](https://developers.google.com/safe-browsing/reference#example-requests); the bounded decoder reads only the hashes, details and duration from the [official v5 schema](https://github.com/googleapis/googleapis/blob/master/google/security/safebrowsing/v5/safebrowsing.proto). JSON responses remain supported when their Content-Type selects JSON; unknown media types and malformed responses are failures, not misses. A threat detail with an unknown threat type or with any attribute (`CANARY`, `FRAME_ONLY`) is ignored | the response's nonnegative `cacheDuration` (seconds and nanos for protobuf), but a listing is reported from the cache only while it is under 30 minutes old and asked again after that; a zero duration is not stored |

- **Failures.** Every failure of an outside service is `unknown`, and a `logger.warn` of at most one line per source per minute that counts the failures it held back. A line names the source and the kind of failure, never a domain, URL or key. `unconfigured` and `disabled` are states shown by `sourceStatus()`, not logged.
- **Safe Browsing response failures.** Warnings identify the JSON parsing/field check or the protobuf message and failed decoding step (tag, wire type, varint, length or duration), without recording response bodies or hashes. Unknown protobuf fields are skipped within their message bounds; missing or invalid durations never produce a guessed cache lifetime.
- **Cache.** `fork_reputation_cache` holds one row per source and subject (the domain, or for Safe Browsing the canonical URL without its scheme) with `fetched_at` and `expires_at`. It is a copy of what the services answered, global rather than per user since a verdict is about a domain, and read only through these functions. `unknown` answers, `unsupported_tld` included, are never stored, so the next lookup asks again. A source that is switched off or has no key neither reads the cache nor sends anything. An expired row stays until its subject is looked up again and the new answer replaces it. Backups leave the table out, as they do the short-lived tokens.
- **Bootstrap.** IANA's bootstrap file is kept in memory for a day after it was fetched. A failed fetch is not kept: every RDAP answer of that lookup is `unknown`, and the next lookup fetches again.
- **Transport.** The HTTP sources go through `safeFetch`, which checks every connection and redirect against private addresses. A response over 1 MiB is an error.

| Path | What |
|---|---|
| `backend/migrations/9002_fork_reputation_cache.sql` | The `fork_reputation_cache` table; creates a new table only |
| `backend/fork-features/reputation/index.js` | `lookupRdap`, `lookupSpamhausDbl`, `lookupUrlhaus`, `lookupSafeBrowsing`, `sourceStatus`: the four sources, limits and the cache |
| `backend/fork-features/reputation/dnsQuery.js` | One DNS `A` query over UDP, returning the negative TTL Node's resolver does not report; a datagram with another id or question is ignored, a truncated or malformed one is an error |
| `backend/fork-features/reputation/dnsQuery.test.js` | Response parsing and the UDP exchange: TTLs, negative TTL, stray and malformed datagrams, no answer |
| `backend/fork-features/reputation/safeBrowsing.js` | URL canonicalization and expressions for Safe Browsing |
| `backend/fork-features/reputation/safeBrowsingResponse.js` | Content-Type-selected JSON/protobuf decoding for hashes.search only; bounded wire fields, threat enum mapping and Duration validation |
| `backend/fork-features/reputation/index.test.js` | Each source against local stand-ins (HTTP servers and a UDP resolver): verdicts, failures, cache lifetimes, warnings, exactly what is sent, and that each function reaches only its own service and cache rows |
| `backend/fork-features/reputation/index.postgres.test.js` | The migration and the cache statements on PostgreSQL, rolled back; runs when `MAILFLOW_TEST_DATABASE_URL` is set |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/plugins/api.js` | Per-source lookups and `sourceStatus`, plus pure `reputationUrlSubject` from `fork-features/reputation` |
| `backend/src/plugins/README.md` | Lists them in the capability surface |
| `backend/src/services/backup.js` | `fork_reputation_cache` is in `TRANSIENT_TABLES`, whose comment now covers caches of outside lookups |

## Reputation tag plugins

`backend/src/plugins/reputation-tags/` registers four independent plugins: `tag-rdap` (`rdap`),
`tag-spamhaus` (`spamhaus_dbl`), `tag-urlhaus` (`urlhaus`) and `tag-safebrowsing`
(`safe_browsing`). A user activates each separately; it applies to every account of that user.
There are no new parameters, quotas or per-account switches. Source keys and the RDAP switch
remain exclusively in the administrator's external-service settings.

- **Snapshot ownership.** Each plugin writes only `messages.plugin_annotations[pluginId]`.
  Alongside K7's `revision` and `queue`, `result` is `complete { checkedAt, subjects }`.
  RDAP subjects map registrable domains to `Registration`; DBL and URLhaus map them to
  `SourceVerdict`. Safe Browsing subjects map `reputationUrlSubject`'s canonical URL digest to
  `{ host, verdict }`, never storing a URL's path or query. A body with no links produces an
  empty subjects object. Snapshots are not refreshed according to cache age.
- **New mail.** Each plugin's 60-second tick owns a `pluginId:accountId` single-flight turn.
  `inboxIngest` only schedules it. The first activated tick records UID floors in
  `plugin_account_config.newMailFloors`; folders newly seen or renumbered take fresh floors.
  It marks up to 200 new rows through `above_uid_floor`. A source without configuration, or
  disabled RDAP, writes no message annotations and retains its initial floors, so configuring
  it later picks up mail received since that tick.
- **Processing.** Using the existing Jev budgets, a tick reads up to 200 queued rows and
  processes at most 50, new mail first, starting none with under 5 seconds of its 60-second
  budget remaining. `ensureMessageBodies` precedes the read-only `getMessageLinks`. Unavailable
  bodies leave the row untouched and spend no attempt; server-confirmed `empty` bodies produce
  an empty snapshot. Unknown source answers are stored immediately together with a retry queue
  in one annotation write. Five attempts use the existing 2, 4, 8 and 16 minute backoff; success
  replaces the unknown snapshot and completes the queue, exhaustion preserves the last unknown
  snapshot and completes it. A source switched off during a lookup writes nothing.
- **Synchronous consumers.** Both `tagSource.read` and `tagSource.ensure` first check current
  activation and source configuration: inactive or unconfigured sources answer that state without
  reading annotations, so retained snapshots cannot contribute chips after deactivation. When
  available, `tagSource.ensure` returns existing complete snapshots without querying, including
  unknown snapshots currently in backoff. A missing snapshot is checked and stored within the
  caller's deadline. A body failure returns
  `unavailable { body_unavailable }`, an exhausted caller deadline `unavailable { deadline }`.
  `tagSource.read` never queries a service. Consumers use `ensureMessageTags`/`getMessageTags`,
  not another plugin's private annotation. HTTP summary likewise only reads stored snapshots.
  `tagSourcePlugins()` returns each registered source's owning plugin id for activation checks.
- **Backfill.** Each plugin keeps `plugin_data[account:<id>:backfill]`, owned by the account's
  user: `idle`, `running`, `completed` or `stopped`, with revision, timestamps and
  `marked`/`processed`/`failed` counters. A running tick marks the next 50 `not_at_revision` rows
  after the pending batch is worked off, and completes only when no further rows or retries
  remain. The authenticated `/api/<pluginId>` router exposes `GET /status` and
  `POST`/`DELETE /accounts/:id/backfill` (409 for duplicate start, ineligible start or stop without a running
  run, 404 for another user's account). A new run requires an enabled IMAP account, current plugin
  activation and an enabled source; an eligibility refusal includes `reason` and writes nothing.
  Stop prevents new marking batches; already queued work
  still finishes and increments `processed` without changing the `stopped` state. These commands,
  ticks and synchronous ensures hold the same plugin/account turn, so progress and stop cannot
  overwrite one another.

Settings → Categories shows each activated plugin's source configuration and per-account backfill status, `marked`/`processed`/`failed` counters, Start and Stop controls through the shared `frontend/src/plugins/reputation-tags/` settings component.

| Path | What |
|---|---|
| `backend/src/plugins/reputation-tags/index.js` | Four manifests with independent source, hook, tick and authenticated router |
| `backend/src/plugins/reputation-tags/model.js` | Snapshot, annotation and stored-record parsing; existing Jev retry values |
| `backend/src/plugins/reputation-tags/records.js` | Per-plugin/account turns, UID floors and owned backfill records |
| `backend/src/plugins/reputation-tags/processor.js` | New-mail marking, batched backfill, source lookup, snapshot read/ensure |
| `backend/src/plugins/reputation-tags/routes.js` | Status and account backfill start/stop |
| `backend/src/plugins/reputation-tags/backfill.js` | Owner-scoped eligibility, inspection and serialized start shared by single-account and bulk entry points |
| `backend/migrations/9006_fork_reputation_queue_indexes.sql` | Per-source partial indexes for queue counts by account/origin/state and pending/retry reads; adds indexes only |
| `backend/src/plugins/loadPlugins.js` | Registers the four manifests after Jev |

## Backfill across accounts and activated plugins

Settings → Plugins shows **Backfill enabled plugins** before the activation list.
Jev and all four reputation plugins remain discoverable while inactive, with each
owned account's eligibility and existing run state. GTD is explicitly unsupported.
**Start all eligible backfills** sends one `POST /api/plugins/backfill` without
client-selected account or plugin ids. It does not turn anything on or change configuration.
Jev additionally requires its per-account `enabled` setting and the administrator's Jev key.

The coordinator reads the current user's owned account list and current activation from their
database sources, bypassing the hot-path activation cache and propagating source-read failures.
For every activated manifest with a `backfill` capability, it requests a start for every owned
account. Each owner rechecks ownership and eligibility and serializes the start with its
existing run writes. A duplicate returns the existing run without resetting counters.
Disabled accounts, non-IMAP accounts, disabled account modules and unconfigured or disabled
services are explicit skips. Temporarily disconnected enabled accounts can start and wait
for their existing connected-account tick.

The response is `{ results: [{ pluginId, pluginName, accountId, emailAddress, outcome }] }`.
Each outcome is `started { backfill }`, `already_running { backfill }`, `skipped { reason }`
or `failed { error: 'start_failed' }`. One failed target does not cancel other starts.
HTTP 200 reports the start commands' conclusions, not completed mail processing.
There is no batch table, coordinator run, automatic retry or rollback.

`GET /api/plugins/backfill` returns registered plugins with activation/capability metadata and
owner-produced account snapshots. An individual inspection failure remains visible as
`failed { error: 'status_failed' }`. The panel reads again after commands, activation changes
and manual refresh; polling waits 15 seconds after each read settles so slow responses can
still become visible. Leaving the page stops reads, not background processing.
**Open plugin settings** leads to the existing per-account configuration and Stop controls
under Settings → Categories.

| Path | What |
|---|---|
| `backend/fork-features/plugin-backfill/` | Stateless capability discovery, owner dispatch, result aggregation and authenticated HTTP router |
| `backend/src/routes/plugins.js`, `backend/src/plugins/registry.js` | Router seam and manifest capability validation |
| `backend/src/plugins/activation.js` | Fresh error-propagating reads for explicit commands; existing cached hot-path behavior remains unchanged |
| `frontend/fork-features/plugin-backfill/` | One-command UI, per-target outcomes and live owner progress |
| `frontend/src/components/AdminPanel.jsx`, `frontend/src/locales/*.json` | Plugins-page mount and translated controls |

## Message tags

The four tag plugins write their findings into their own namespace of a message's annotations. Owners parse their private state; the fixed stored-result queries below additionally validate a small public read projection for counting and filtering. For live mail consumers, `fork-features/message-tags` dispatches through each owner's `tagSource`: `ensureMessageTags(accountId, ids, { deadlineMs })` returns, for every requested message, a state for each of the four sources — `inactive` (that plugin is not activated for the user), `unconfigured` (its source has no key, or is switched off), `complete { checkedAt, subjects }` (the snapshot the plugin stored, in the source's own types), `unchecked` (nothing stored yet; the read path only) or `unavailable { reason }` with `reason` `plugin_failed`, `deadline` or `body_unavailable` — and asks a plugin to look a missing snapshot up, waiting up to the caller's deadline. `getMessageTags(accountId, ids)` answers from what is stored and contacts nothing. A plugin that throws, answers outside this contract, or leaves a requested message out is that source's `plugin_failed`: logged, and never passed on to a consumer. `POST /api/message-tags/summary { ids }` answers the caller's own messages with the chips worth showing and a per-source summary that carries no domain and no URL. The plugin API exports `ensureMessageTags`, `getMessageTags`, `tagSourcePlugins` and the read-only `getMessageLinks`.

| Path | What |
|---|---|
| `backend/fork-features/message-tags/index.js` | `ensureMessageTags`, `getMessageTags`, `summarizeForUser`, the tag states and `NEW_DOMAIN_MAX_AGE_MS` |
| `backend/fork-features/message-tags/routes.js` | `POST /api/message-tags/summary`, signed-in user only, own messages only |
| `backend/fork-features/message-tags/index.test.js`, `routes.test.js` | The state contract, the failure paths, chips and the HTTP entry |
| `backend/src/plugins/registry.js` | `tagSource` on a manifest: one source per plugin, checked at registration |
| `backend/src/plugins/api.js` | `ensureMessageTags`, `getMessageTags`, `tagSourcePlugins`, `getMessageLinks` |

### Tags in the mail list

Every message row and every open message shows what the tag plugins found for it, and a single user preference `showMessageTags` (Settings, stored in `users.preferences`) turns the whole thing off. The list shows the findings worth noticing — a domain a lookup source lists, a domain registered in the last 30 days, or a source that could not answer — and the message view additionally lists the state of all four sources, including the ones the user has not activated, because "not checked" and "not enabled" are different facts. Core owns this rendering: it reads `POST /api/message-tags/summary` for the message ids currently on screen (one request per set of visible ids, the way the reply-draft indicators work) and never looks a source up itself, so scrolling and opening messages cost no outside queries. With the preference off, nothing is requested and nothing is drawn.

## Inspecting stored plugin results

Settings → Plugins offers **View stored results** on Jev and each of the four reputation
plugins, even when the plugin is disabled. The panel filters by account and result type,
shows counts and a cursor-paged mail list, expands the saved observation and opens that
exact physical mail record. It reads existing results only: no lookup, body ensure,
classification, training, backfill, activation or configuration write.

- **Counting unit and lifetime.** One live `messages` row owned by the signed-in user
  (`is_deleted = false`), across all folders including Sent, Drafts and Trash. Folder/label
  copies count separately, even with the same RFC Message-ID; multiple matching subjects
  in one row count once per facet. Moving, copying or deleting rows can change the totals.
  These are current stored-record counts, not cumulative decisions, request totals or queue
  completion counters. No saved assessment does not imply the mail was never processed.
- **Jev.** `checked` means a valid saved `spam.decision.kind = 'done'`. The owner's existing
  thresholds produce `spam` (≥ 0.9), `ham` (≤ 0.1) or `uncertain`; pending, retry, failed and
  disabled spam decisions remain separate. Details show probability, model, decision time
  and the saved training outcome, not the current training database total. Category actions
  and queue completion are not spam judgments.
- **Reputation.** A valid complete snapshot counts as checked, including empty subjects
  and unknown answers. RDAP distinguishes registered, new domain, not found, unknown and
  no links; new domain uses the shared 30-day window at the snapshot's `checkedAt`, not
  today's date. Listing sources distinguish listed, not listed, unknown and no links:
  any listed subject is a match, but `not_listed` requires a nonempty set with every
  subject not listed. Facets overlap and cannot be added together. Unrecognized public
  result formats are explicit `unrecognized` and `not_checked`, never treated as safe.
- **Saved versus live.** Current activation and service configuration are displayed
  separately from the saved annotation revision and observation time. Inspection retains
  old results when a plugin is inactive or unconfigured; it neither asserts that they
  are current nor makes them eligible for live chips or classification consumers.
- **HTTP.** Each of the five authenticated owner routers exposes `GET /results` with
  optional `accountId`, `facet`, `cursor` and `limit` (1–200, default 50), and
  `GET /results/:messageId`. The page is `{ observedAt, plugin, accounts, counts,
  messages, nextCursor }`; detail is `{ observedAt, plugin, message }`. Messages contain
  whitelisted metadata, facets and an owner-produced observation, never the raw annotation.
  Missing/foreign accounts or mail records are 404; invalid ids, facets and cursors are 400.
  A cursor is bound to plugin, account scope and facet; sorting is mail date descending,
  null dates last, then physical UUID descending.
- **Query boundary.** `readJevSpamResults`/`readJevSpamMessage` bind the Jev namespace;
  `readReputationResults`/`readReputationMessage` resolve a source's owning plugin through
  `tagSourcePlugins()`. Fixed Jev, RDAP and listing SQL projections validate only the
  public result fields. One SQL statement gives counts and a page from the same snapshot;
  only page annotations reach the owner DTO parser. Each later page is a fresh read.
  There is no summary table/cache, schema migration or persisted derived facet.
- **Reading mail.** Jev's saved spam detail appears in the normal reading pane, expanded
  conversation cards and detached windows. The existing four-source live summaries stay
  activation-gated. Open mail uses the selected row UUID, never a Message-ID fallback;
  an ephemeral single-message presentation prevents conversation deduplication from
  selecting another copy. In the main pane, its existing `__dl_<UUID>` point-lookup record
  takes precedence over a grouped row's thread-level subject/sender; no additional main-pane
  fetch or cache is created. The next ordinary selection restores automatic presentation;
  no conversation preference is changed. Ordinary mark-as-read behavior remains separate
  from result inspection.

| Path | What |
|---|---|
| `backend/fork-features/plugin-results/` | Fixed ownership-scoped SQL projections, facets, cursor parsing and PostgreSQL contract tests |
| `backend/src/plugins/jev-classify/results.js`, `reputation-tags/results.js` | Owner-authenticated endpoints and whitelisted observation DTOs |
| `frontend/fork-features/plugin-results/` | Shared panel, saved observations, Jev reading detail and exact-row navigation |
| `frontend/src/components/AdminPanel.jsx` | Plugin metadata-driven result entry, independent from activation |
| `frontend/src/components/ReadingPane.jsx`, `frontend/src/store/index.js` | Transient exact-row presentation, reset by ordinary selection |
| `frontend/src/components/MessagePane.jsx` | Main-pane `resolvePresentedMessage` precedence for an existing exact UUID snapshot; detached panes consume their window-owned physical row |

## Detached physical-message windows

Ordinary context-menu and double-click opens resolve `GET /api/mail/messages/:UUID`
before displaying a single message or scheduling read-on-open. Each window descriptor owns
one `loading`, `ready { message }` or `error { error }` result for its lifetime. Its outer
title, inner pane and minimized dock use that same physical row, never grouped list metadata
or a thread/deep-link cache. List refreshes cannot replace it; flag updates patch the exact
UUID, and removal, close, lock or an identity change retire it. A late read cannot populate
a subsequently reopened window. A failed read displays an error; close and reopen to retry.

The exact endpoint returns the normalized thread key for replies and a singleton
`message_count`, not the thread's total. Grouped list subjects, senders and counts are
unchanged. Existing list-selection shortcut precedence is retained; only the no-selection
detached fallback uses the ready window's physical message. Read-on-open retains its
manual/delay/instant policy and the originating list's aggregate unread count for rollback;
delayed reads follow the latest user opening, not the order of exact HTTP responses.


## Anti-spam training records and verdict requests

Jev's confident spam and ham verdicts can train a user's anti-spam model, so a new user's model is ready without hundreds of manual marks, and a plugin can ask anti-spam for a message's verdict instead of guessing from `spam_analyzed_at`, which stays empty for mail stored before anti-spam was switched on.

- **One writer.** `backend/src/services/spamTraining.js` is the only code that writes `spam_training_log`. Each write starts from a `messages` row id and loads the row itself; the caller passes no features. `POST /messages/:id/spam` and `/ham` call `captureManualSpamLabel` before the move, which takes the features from the row as it is then, and call the returned `record({ uid, folder })` once the message is in its destination folder. That writes the same `manual` record as before (the destination folder and the UID there, the same feature columns, plus the language and tokenizer version below) and feeds the model of the message's language incrementally, also when the row was deleted during the move.
- **Jev records.** `recordJevSpamVerdict({ messageId, label })` writes a record with `source = 'jev'` and returns `{ kind: 'recorded' }`, `{ kind: 'duplicate' }` (that account already has a Jev record for this Message-ID), `{ kind: 'no_message_id' }` or `{ kind: 'message_missing' }`. A unique index on `(user_id, account_id, message_id_header)` over Jev records makes the write idempotent per account; another account that received the same message keeps its own record. Jev records get no incremental training; they reach the model at the next retrain. No other automatic source may write training records.
- **Retrain.** `requestSpamRetrain(userId)` runs the existing full retrain of that user and returns `{ kind: 'retrained', records }`, `{ kind: 'no_training_data' }`, `{ kind: 'failed', reason }`, or `{ kind: 'already_running' }` while a retrain it started for the same user is still running. Every retrain, scheduled or requested, leaves out a Jev record when the same account has a manual record for the same Message-ID: the user's own mark wins. Decay is unchanged; the models are per user and per language (below).
- **Verdict requests.** `ensureSpamVerdict(messageId)` returns `{ kind: 'verdict', verdict, override }` from the row when it has been analyzed (a user mark counts), `{ kind: 'disabled' }` when the user's anti-spam master switch or the account's anti-spam switch is off, and otherwise classifies the message on the spot with its retained headers, storing the verdict as ingest would but never moving the message. A message whose headers cannot be read, a missing row and a failed classification are `{ kind: 'error', reason }`; no verdict is stored for them. Header failures are logged by the header store, the others with `logger.warn`.
- All three are in the plugin API.

| Path | What |
|---|---|
| `backend/src/services/spamTraining.js` | `captureManualSpamLabel`, `recordJevSpamVerdict`, `requestSpamRetrain`; feature extraction moved from `routes/mail.js` |
| `backend/src/services/spamTraining.test.js` | Stored columns of both sources, the four Jev outcomes, retrain outcomes and per-user single flight |
| `backend/src/services/spamPipeline.ensureSpamVerdict.test.js` | Stored verdict without reclassifying, on-demand classification without a move, both switches, header and classification failures |
| `backend/migrations/9003_fork_spam_training_jev.sql` | Adds `jev` to `spam_training_log_source_check`; partial unique index `spam_training_log_jev_message_uniq` |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/routes/mail.js` | `extractSpamFeatures` and `logSpamTraining` removed; `/spam` and `/ham` capture the mark with `captureManualSpamLabel` before the move and record it after |
| `backend/src/routes/mail.spam.test.js` | Mocks follow the training record's own row read |
| `backend/src/services/spamModelStore.js` | `retrainUser` leaves out Jev records superseded by a manual record |
| `backend/src/services/spamPipeline.js` | Header comment names the Jev exception; new `ensureSpamVerdict` |
| `backend/src/plugins/api.js` | Exports `recordJevSpamVerdict`, `requestSpamRetrain`, `ensureSpamVerdict` |
| `backend/src/plugins/README.md` | Lists them in the capability surface |

## Per-language anti-spam models

A user's anti-spam model is split by language: each language the user's training records are in has its own Naive Bayes model (a partition), trained only on records of that language and used only for mail of that language. Words of one language no longer dilute the statistics of another, and a language with little training never borrows a mature model of another.

- **The language of a message** is the tag the message signals' `resolveLanguage` gives for its subject and its `Content-Language` header, with the body left out (`partitionLanguage` in `spamModelStore.js`). The body a message is classified with at ingest and the one stored when the user marks it later can differ (a row ingested without its body, a fetch that failed), so a language read from the body could put the training record in another partition than the one the message was classified with. Training reads `Content-Language` from the retained headers, classification from the headers it is given; headers that cannot be read count as no declaration. Most Latin-script subjects carry too few stop words to tell the language apart and land in `und-Latn` unless the sender declares one.
- **Tokens.** Chinese and Japanese text is cut into words with `Intl.Segmenter` (so `药店` is one token, not `药`); every other language keeps the runs of letters and digits, which keeps Korean words whole. A message drops the stop words of its own language only: the lists in `src/services/stopWords.js` for `en`, `it`, `de`, `es`, `fr`, `ru` and `zh`, the English default list for an undetermined language (`und`, `und-Latn`, `und-Cyrl`), and none for a language without a list. A single Han character is a token; other single characters are not.
- **Training records** store their partition in `spam_training_log.language` and the `TOKENIZER_VERSION` their `token_counts` were made with in `tokenizer_version`. A retrain first brings every record of the user to the current version: a record without a language gets one from its stored subject (its `Content-Language` was never stored; no subject gives `und`), and its `token_counts` are made again from its stored subject and body. These are written back to the record, so this happens once per record.
- **Models.** `spam_models` has one row per `(user_id, language)`. A retrain builds every partition from its own records with the same decay as before and replaces the user's partitions in one transaction, removing a partition that has no records left; a mark updates its partition incrementally. A message is classified with the partition of its language; when that partition has fewer than 50 records the verdict is rules-only, as for the whole model before. The verdict's `spam_details.partition` records `{ language, trainingRecords }`.
- **Decay** stays a per-user setting, now `users.preferences.spamDecayThresholdDays` (default 90, 7–365), shared by all partitions. Resetting training data deletes all of the user's partitions and leaves the decay setting as it is.
- **Status and "Why?".** `GET /api/spam/status` returns `partitions: [{ language, trainingRecords, maturity, lastTrainedAt }]` (largest first) with `decayThresholdDays`; `GET /api/spam/explain` returns `partition: { language, trainingRecords, maturity }`, or `null` for a verdict stored before partitions existed. The anti-spam settings page lists the partitions and the "Why?" dialog names the one the verdict used.
- **Upgrading.** Migration 9004 deletes the existing language-blind models (all of their counts can be rebuilt from `spam_training_log`) after moving the decay setting. Run a full retrain right after it (admin "retrain now", or `requestSpamRetrain` per user); until a user is retrained, mail is judged by rules only and the status lists no partitions, and the hourly scheduler retrains each user within a day.
- **Concurrency.** As before, the scheduler, `requestSpamRetrain` and incremental updates are not serialized against each other: a mark that lands while a retrain is running can be overwritten by that retrain until the next one. The partition replacement itself is atomic.

| Path | What |
|---|---|
| `backend/migrations/9004_fork_spam_language_partitions.sql` | `spam_training_log.language`, `tokenizer_version`; decay to `users.preferences`; `spam_models` keyed by `(user_id, language)` |
| `frontend/src/components/SpamPartitions.render.test.js` | Render test: partition table and empty line in the settings, partition and legacy line in "Why?" |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/services/spamTokenizer.js` | `tokenize(message, language)`: `Intl.Segmenter` for zh/ja, per-language stop words, `TOKENIZER_VERSION`, `countTokens`; the stop-word union and the first-character CJK cut are removed |
| `backend/src/services/spamModel.js` | `retrainFromRecords` reads `token_counts` only; `maturityOf` |
| `backend/src/services/spamModelStore.js` | Partitions: `partitionLanguage`, `getModelsForUser`, `getModelForUser(userId, language)`, `saveModel`/`updateIncrementalForUser` per partition, decay in preferences, `retrainUser` re-tokenizes stale records and replaces partitions |
| `backend/src/services/spamTraining.js` | Records carry `language` and `tokenizer_version`; incremental training of the record's partition |
| `backend/src/services/spamPipeline.js` | Classifies with the partition of the message's language; `spam_details.partition` |
| `backend/src/routes/spam.js` | Status lists partitions; decay read/written in preferences; explain names the partition |
| `frontend/src/components/SpamSettings.jsx`, `frontend/src/components/SpamExplainModal.jsx`, `frontend/src/locales/*.json` | Partition table in the settings, partition line in "Why?", their strings |
| `backend/src/services/spam*.test.js`, `backend/src/routes/spam.test.js`, `backend/src/routes/mail.spam.test.js` | Follow the per-language contract; tokenizer, partition choice and per-user isolation cases |

## Plugin work queue and verified move

A plugin can work through an account's mail in batches and move messages on the server without ever moving the wrong one. Both are plugin API capabilities.

### Work queue

The queue is the plugin's own namespace in `messages.plugin_annotations`. Of that namespace this feature owns two fields, `revision` (a non-negative integer the plugin defines) and `queue = { state, dueAt, origin }` with `state` one of `pending`, `retry`, `done`, `terminal`, `dueAt` an ISO 8601 time or `null`, and `origin` `backfill` or `new_mail`. Every other field, and the business meaning of each state, belongs to the plugin. A user move that replaces a row carries its annotations to the new row, so queued work follows the message.

- **Processable rows** are rows not flagged `\Deleted` outside the account's Sent, Drafts and Trash folders, resolved from `folder_mappings` and special-use flags the way the rest of MailFlow resolves those roles.
- `markMessages({ accountId, pluginId, scope, revision, origin, limit })` writes `revision` and `queue = { state: 'pending', dueAt: null, origin }` on up to `limit` processable rows in one `UPDATE` and returns how many it wrote, keeping the namespace's other fields. A row a concurrent writer changed after it was picked is checked again before it is written. The scope is one of:
  - `{ kind: 'not_at_revision' }`: rows without the annotation or with another `revision`.
  - `{ kind: 'above_uid_floor', floors }`, with `floors` a `Record<folder, { uidValidity, nextUid }>`: rows without the annotation, in a listed folder whose stored UIDVALIDITY still equals the floor's, with `uid >= nextUid`. UIDs are assigned by the server and only grow within one UIDVALIDITY, so this is mail that entered the folder after the floor was taken; the sender's Date plays no part, and a folder the server renumbered marks nothing.
- `currentUidFloors({ accountId })` gives each processable folder with a known UIDVALIDITY its `{ uidValidity, nextUid }`, `nextUid` being one past the highest UID MailFlow holds there (rows flagged `\Deleted` included, since their UIDs are spent), or 1 when it holds none.
- `listQueuedMessages({ accountId, pluginId, now, limit })` returns rows whose queue is `pending`, or `retry` with `dueAt <= now`, earliest `dueAt` first with `pending` ahead of all, then by id; at most 200. Each row is `{ id, folder, uid, message_id, date, synced_at, plugin_annotation }`, `plugin_annotation` being the plugin's namespace.
- `countQueued({ accountId, pluginId, origin })` returns `{ pending, retry, done, terminal }` for the rows marked with that origin, and throws on a state outside those four.
- `listMessagesInQueueState({ accountId, pluginId, state, afterId, limit })` returns the rows whose queue is in `state`, by id, after `afterId` (`null` for the first page); at most 200, in the shape `listQueuedMessages` returns. A plugin pages through its `terminal` rows this way to retry them.
- `setMessageAnnotation` resolves to `{ kind: 'written' }`, or `{ kind: 'message_missing' }` when the row is gone: deleted, or replaced under a new id by a move. GTD's gist cache counts only written gists.

Queue indexes belong to each plugin: Jev uses `9005_fork_jev_classify_queue_indexes.sql`, and the four reputation plugins use `9006_fork_reputation_queue_indexes.sql`. Reputation counts index account, origin and state; ready reads index only pending/retry rows. These indexes keep status polling and background queue reads from repeatedly scanning every message of an account. Both migrations build concurrently and rebuild on retry so an interrupted build's invalid index is replaced rather than skipped.

### Verified move

`moveMessagesVerified({ accountId, messageIds, toFolder })` resolves to a `Map` from each requested row id to its outcome. Rows are grouped by source folder and each group is one pooled IMAP session:

1. Before any IMAP: a row that is gone or flagged `\Deleted` is `failed { reason: 'message_missing' }`; one already in `toFolder` is `already_there`; one without a Message-ID is `no_message_id` and is never moved; a `toFolder` that is not one of the account's folders is `folder_missing`; a source folder whose UIDVALIDITY was never recorded is `uidvalidity_unknown`.
2. Under the source folder's mailbox lock: a UIDVALIDITY on the server other than the stored one makes the whole group `uidvalidity_changed`. Otherwise one `UID FETCH` of the envelopes, and a UID the server does not hold or that carries another Message-ID is `source_changed`. Only the UIDs whose Message-ID matches are moved, in the same session and under the same lock: `UID MOVE` when the server declared MOVE after login, otherwise `UID COPY` and an `EXPUNGE` of only those UIDs (`moveUids`). Dates are never compared.
3. The target UID: when the server declared UIDPLUS after login, from its `COPYUID`. Without UIDPLUS a `COPYUID` the server sends anyway is ignored, because RFC 4315 does not bind it; the target's `UIDNEXT` is read with `STATUS` before the move, and after the move the same session selects the target and runs `UID SEARCH UID <UIDNEXT>:* HEADER Message-ID <id>`; a single hit at or above `UIDNEXT` is the target UID.
4. The local row follows only what the server confirmed. `moved { uid }`: a row a sync already created at the target UID gives way, and the moved row takes the target folder and UID in place, keeping its id, its plugin annotations and its retained headers. `moved_unlocated`: the server confirmed the move but no single target UID is known (UIDPLUS without that UID in `COPYUID`, no or several search hits, or the search failed); the row's folder becomes the target with its source UID, guarded for 10 seconds from delete reconciliation, a sync of the target is started and a `logger.warn` is written. The next syncs replace that row, so the message may lose its row id and annotations, but not its place on the server. If another row already holds that UID in the target, the moved row stays in the source until the source sync drops it.
5. Folder counts are adjusted for the rows that moved, and `folder_updated` is broadcast for the source and the target.

Other outcomes: `failed { reason: 'imap_error' }` (the session failed before the move was confirmed) and `failed { reason: 'move_not_confirmed' }` (the server refused the move). Only `moved`, `moved_unlocated` and `already_there` leave the message in the target; `source_changed`, `uidvalidity_*` and `failed` can be retried once sync has rebuilt the local rows. When the server confirmed a move but the row could not be updated, the outcome is still `moved` and the failure is logged, since calling a move that happened failed would invite moving it again. On a server without MOVE, a copy whose source could not be expunged is reported as moved and leaves the message in both folders, as everywhere else `moveUids` is used.

Label-store accounts (Gmail) are not moved this way; a plugin labels them with `applyLabel` and creates label folders with `ensureLabelFolders`.

| Path | What |
|---|---|
| `backend/fork-features/work-queue/index.js` | `markMessages`, `currentUidFloors`, `listQueuedMessages`, `listMessagesInQueueState`, `countQueued` |
| `backend/fork-features/work-queue/index.test.js` | PostgreSQL tests: scopes, excluded folders, kept fields, limits, concurrent writers, selection order, counts, paging by queue state, annotation write results |
| `backend/fork-features/verified-move/index.js` | `moveMessagesVerified`: pre-checks, per-folder groups, local row updates, counts, broadcasts |
| `backend/fork-features/verified-move/index.test.js` | IMAP sessions recorded down to wire commands against PostgreSQL rows: both capability branches, every outcome, no write command when identity fails |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/services/imapManager.js` | New `moveVerifiedUids(account, { fromFolder, uidValidity, items, toFolder })`: identity check, move and target UID over one pooled session |
| `backend/src/services/mailAccess.js` | `setMessageAnnotation` resolves to `{ kind: 'written' }` or `{ kind: 'message_missing' }` instead of a row count |
| `backend/src/plugins/gtd/gtdGist.js` | Counts a gist as written only on `{ kind: 'written' }` |
| `backend/src/plugins/api.js` | `markMessages`, `currentUidFloors`, `listQueuedMessages`, `listMessagesInQueueState`, `countQueued`, `moveMessagesVerified` |
| `backend/src/plugins/README.md` | Lists those capabilities and the new `setMessageAnnotation` result |

## Message signals

One structured view of a stored message, built from its `messages` row and its retained headers, for everything that judges mail: the anti-spam pipeline, its training, and the state sent to Jev. Consumers take these signals from this module rather than parsing the message themselves, so they all reach the same conclusions.

- `extractSignals({ message, headers, account })` is pure. `message` is a `messages` row, `headers` the header read result for it (`stored` or `unavailable`), `account` its account row, of which only `trusted_authserv_id` is read. It returns:
  - `sender { from { name, email }, sender { name, email } | null, replyTo [{ name, email }] }`, `recipients { to, cc }` (counts), `subject`, `date` (ISO), `thread { isReply }` (the message has an `In-Reply-To`).
  - `authentication`: `{ kind: 'trusted', authservId, spf, dkim, dmarc }` when one of the stored `Authentication-Results` headers carries the authserv-id the account trusts, with that header's results (`null` for a method it does not report); `{ kind: 'untrusted', authservIds }` when there are such headers but none from that id, or the account trusts none; `{ kind: 'absent' }` when the stored headers have none; `{ kind: 'headers_unavailable', reason }` when the headers could not be read. This is the anti-spam pipeline's trust gate, applied with the account's setting at the time of the call: changing the trusted id changes the result without re-ingesting anything, and no derived trust flag is stored.
  - `links`: the first 50 `http(s)` anchors of the HTML body, each `{ href, hrefHost, hrefDomain, text, textHost, textDomain, mismatch }`. `text` is the anchor's visible text with whitespace collapsed, cut to 200 characters. `textHost` is set only when that whole text is an address (`https://www.bank.com/verify`, `www.bank.com`); "Click here" has none. Domains are registrable domains from the Public Suffix List (above), and `mismatch` is true exactly when the text names a domain other than the one the link goes to. `javascript:`, `mailto:` and relative links are left out. Plain-text bodies have no anchors and so no links.
  - `attachments [{ filename, type }]`; `mailingList { listUnsubscribe, listId, bulk }` (`listId` from the stored `List-Id` header).
  - `language` as `resolveLanguage` gives it, with the stored `Content-Language` header as the declared content language.
- `resolveLanguage({ subject, bodyText, bodyHtml, contentLanguage })` is pure and returns `{ resolved, declared { htmlLang, contentLanguage }, script { dominant, letters } }`. The text is the subject and `bodyText` (or, without it, the visible text of `bodyHtml`, script and style left out); its first 4000 letters are counted by script (ISO 15924: `Latn`, `Cyrl`, `Hani`, `Hrkt` for kana, `Hang`, `Thai`, `Grek`, `Hebr`, `Arab`, and `Zzzz` for any other). The HTML declaration is the `<html>` element's `lang`, or else the first element's `lang`; the content language is the first value of `Content-Language`. Both are canonicalized with `Intl` and kept in `declared`, an invalid tag counting as none. `resolved` is the first of these that applies:
  1. Kana make up at least 10% of the letters: `ja`. Hangul, Thai, Greek, Hebrew or Arabic is the dominant script: `ko`, `th`, `el`, `he`, `ar`.
  2. Han is the dominant script: the declared language when it is `ja`, `zh` or `ko`, otherwise `zh`.
  3. Latin or Cyrillic is the dominant script: the language among `en`, `it`, `de`, `es`, `fr` and `ru` whose stop words (`src/services/stopWords.js`) occur at least 3 times and at least 1.5 times as often as the runner-up's; otherwise the declared language if its script is the dominant one; otherwise `und-Latn` or `und-Cyrl`.
  4. Otherwise, with no letters or another script: the declared language, or `und`.

  Wherever a declaration decides, `resolved` is its primary language subtag (`zh-CN` gives `zh`), so the same language gets one tag whether or not a template declares it; the full tags stay in `declared`.
- Stored bodies are the sanitized HTML, and the sanitizer drops the `<html>` and `<body>` elements with their `lang`. For mail read from the database `htmlLang` is therefore the first `lang` on an element inside the body, or `null`; an `<html lang>` is seen only when raw HTML is passed in.
- `messageLinks({ bodyHtml })` is pure and returns the `links` of a stored HTML body exactly as `extractSignals` reports them, for a consumer that needs the links alone.
- `getMessageSignals(messageIds, { deadlineMs })` loads the rows with one query, reads all their headers with one `getMessageHeaders` call (which fetches missing ones from the server, one session per folder, within `deadlineMs`), and returns a `Map` from id to signals; an id without a row is not in it. `getAccountMessageSignals(accountId, messageIds, { deadlineMs })` does the same for the messages of one account only. Plugins get the account form as `getMessageSignals(accountId, ids, { deadlineMs })`.
- `getAccountMessageBodyTexts(accountId, messageIds)` returns a `Map` from id to the message body as `messageBodyText` gives it (`body_text`, or the visible text of `body_html`, `''` when neither is stored), with one query and the same account scoping; plugins get it as `getMessageBodyTexts(accountId, ids)`. A body that is not stored reads as `''`, and such a message has no links either; `ensureMessageBodies` (below) fetches and stores it first.
- `messageBodyMarkdown({ bodyText, bodyHtml })` uses the same Rust core as OMP's local HTML reader (`html_to_markdown_rs`), through its official Node binding `@xberg-io/html-to-markdown`. A nonblank HTML body takes precedence over its text alternative and is converted with enabled `Aggressive` preprocessing, `removeNavigation: true`, `removeForms: true` and `Tier2`. A `DepthLimitExceeded` warning is an error, not a partial successful document. With no HTML, the text body is returned unchanged, or `''` when neither is stored. Conversion is local: it neither opens message links nor sends mail to an external reader.
- `getAccountMessageBodyMarkdowns(accountId, messageIds)` queries the stored bodies once and returns a `Map<id, ready { document } | failed { reason: 'conversion_failed' }>`; plugins get it as `getMessageBodyMarkdowns`. A failed HTML conversion never falls back to raw HTML or the text alternative and does not block other rows in the batch. Missing or foreign rows stay absent; a database read failure rejects the call rather than masquerading as a message failure. The generic text capability and language/link extraction remain unchanged.

| Path | What |
|---|---|
| `backend/fork-features/signals/index.js` | `extractSignals`, `resolveLanguage`, `messageBodyText`, `messageLinks`, `getMessageSignals`, `getAccountMessageSignals`, `getAccountMessageBodyTexts` |
| `backend/fork-features/signals/index.test.js` | Signal set of a phishing message; authentication variants; link limits and domains; language rules; one header read per batch; body texts of one account |
| `backend/fork-features/signals/markdown.js` | OMP-compatible local Markdown conversion and account-scoped per-message outcomes for Jev |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/plugins/api.js` | Account-scoped signals, plain-text bodies, cleaned Markdown documents and stored links |
| `backend/src/plugins/README.md` | Lists those capabilities and the Markdown result contract |

## Message bodies at ingest and on demand

A message is judged with its body: anti-spam classifies new mail at insert and the Jev classification sends the body and its links, so MailFlow stores the body when it ingests a message, and a plugin can have an older message's body fetched and stored before it judges it.

- **At ingest.** Every provider profile has `fetchBody: true`, so `syncMessages` fetches the body of every new message it reads and `backfillMessages` of every message in its batches, the row is inserted with `body_html`/`body_text`, and anti-spam sees the body and its links at insert. A provider that takes guessed part numbers (`speculativeFetch: true`: Microsoft, Apple, Strato, generic) gets the body parts (`BODY_PREFETCH_PARTS`) in the same FETCH that reads the message. The others get the message FETCH without body parts, and `withTextParts` then fetches by UID the text parts each structure names, one FETCH per part number: Gmail fails a whole FETCH that names a part one of its messages lacks (`Some messages could not be FETCHed`), and PurelyMail's profile records malformed literals for sibling parts asked for together. A message any of whose parts failed is stored without a body, with one `logger.warn` per failed part number, and `ensureMessageBodies` fetches the body when a plugin needs it. The profile alone decides: `syncMessages` no longer takes the `prefetchBody`/`noBodyParts` arguments with which every caller kept sync body-free. Flag scans still fetch only UIDs and flags, and batch sizes, delays and connection limits are unchanged. A row ingested before this keeps no body until something fetches it. PurelyMail's profile also records slow body fetches; no account of this deployment uses PurelyMail.
- **On demand.** `ensureMessageBodies(engine, accountId, messageIds, { deadlineMs })` resolves to a `Map` from every requested id to `{ kind: 'stored' }` (the row has a body), `{ kind: 'fetched' }`, `{ kind: 'empty' }` or `{ kind: 'unavailable', reason }` with `reason` `provider_refusing`, `imap_error`, `message_missing` or `deadline`. Each row without a body is fetched with `fetchMessageBody` by its own folder and UID, so each label copy of a Gmail message is fetched for its own row; rows are fetched one after another and the deadline is checked before each. The body is written as `prefetchNewMessageBodies` writes it (sanitized HTML, text, attachments, snippet), and only while the row still has neither `body_html` nor `body_text`: a body stored meanwhile is kept and the outcome is `stored`. `empty` means the server gave nothing renderable and nothing is written; `fetchMessageBody` answers the same way when its UID FETCH stays empty after its retry, so `empty` can also mean the message is no longer on the server. No row of that account with the id, or a row deleted during the fetch, is `message_missing`.
- **Stopping.** As in `prefetchFolderBodies` (`_bodyFetchFailure` in `imapManager.js`): MailFlow's own backoff gate refusing the fetch, or the provider refusing the connection or the login, stops the batch at once and arms the secondary backoff; three failed fetches in a row stop it too. Every message not fetched after a stop is `unavailable` with the stop's reason. A stop or a failure is one `logger.warn` naming the message id, never its content. Database errors are thrown.
- Plugins get it as `ensureMessageBodies(accountId, ids, { deadlineMs })`.

| Path | What |
|---|---|
| `backend/fork-features/message-bodies/index.js` | `ensureMessageBodies` |
| `backend/fork-features/message-bodies/index.test.js` | Outcomes; a stored body neither fetched nor overwritten; stops at a refusal, a rejected login and three failures in a row; the deadline; the write on PostgreSQL when `MAILFLOW_TEST_DATABASE_URL` is set |
| `backend/fork-features/message-bodies/ingest.test.js` | Live sync, a first sync and a backfill insert new, already read messages with their bodies before anti-spam sees them: in the message FETCH on the Microsoft and generic profiles; on Google from a server that refuses a FETCH naming a missing part, without such a FETCH; on PurelyMail without asking for sibling parts together; and a Google message whose part fetch failed is still stored and classified, without a body |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/services/imapManager.js` | Every provider profile `fetchBody: true`; `syncMessages` drops `prefetchBody`/`noBodyParts` and all its callers follow; for `speculativeFetch: false` sync and backfill take the text parts after the message FETCH (`withTextParts`, `bodyTextParts` split out of `extractBodyFromMsg`); new `_bodyFetchFailure(account, err, consecutiveErrors)` with `prefetchFolderBodies`' stop policy |
| `backend/src/services/imapManager.test.js`, `backend/fork-features/headers/ingest.test.js` | Call `syncMessages` without the removed arguments |
| `backend/src/services/spamModelStore.js`, `backend/src/services/spamPipeline.js` | Comments on when a body is stored |
| `backend/src/plugins/api.js` | `ensureMessageBodies(accountId, ids, { deadlineMs })` with the mail engine bound in |
| `backend/src/plugins/README.md` | Lists `ensureMessageBodies` in the capability surface |

## Link rules in anti-spam

The anti-spam rules see where a message's links go: a link that shows one domain and goes to another, a link to a domain registered in the last 30 days, a link to a domain a lookup source lists, and a URL Safe Browsing lists. The same conclusions become flags of the training records, so the model learns them and keeps them after Jev is switched off.

- **Link evidence.** `linkEvidenceFor(message, { lookUpReputation })` (`fork-features/link-evidence`) reads a `messages` row's links with `messageLinks` and, when `lookUpReputation` is set, calls `ensureMessageTags(message.account_id, [message.id], { deadlineMs: LINK_LOOKUP_DEADLINE_MS })`. The budget remains 5 seconds, measured by tag dispatch from the call. It resolves to `{ kind: 'body_unavailable' }` when the row has neither `body_html` nor `body_text`, `{ kind: 'lookup_disabled', mismatch }` without requesting tags, or `{ kind: 'checked', mismatch, links: { domains, urlDigests }, tags }`. Current link identities contain registrable domains and `reputationUrlSubject` digests, not URL text; `tags` retains the unchanged four-source snapshots. Neither classification nor training calls source queries directly.
- **Flags.** `linkFlags(evidence)` gives `link_text_domain_mismatch`, `link_domain_new`, `link_domain_listed` and `link_url_unsafe`, each `1`, `0` or `null` (the evidence cannot tell). Mismatch is 1 when any link's text names another domain than its destination. New is 1 when any destination was registered less than `message-tags`' shared `NEW_DOMAIN_MAX_AGE_MS` before the RDAP snapshot's own `checkedAt`, else `null` when some registration is unknown (or its date is unusable), else 0; `not_found` is not new. Listed aggregates Spamhaus DBL and URLhaus; unsafe aggregates Safe Browsing URL verdicts. A listing wins; otherwise an unknown, an `unavailable` of any reason, or a current subject missing from a complete snapshot makes the flag null. `inactive` and `unconfigured` contribute no input without invalidating another source's definite answer; no answer gives null. Without a body all four flags are null; without a tag request only mismatch is known. Complete empty snapshots give 0 only when the current message has no relevant links.
- **Rules.** `LINK_TEXT_DOMAIN_MISMATCH` (0.5), `LINK_DOMAIN_NEW` (0.4), `LINK_DOMAIN_LISTED` (0.6) and `LINK_URL_UNSAFE` (0.6) fire only when their flag is exactly 1. The rules stay synchronous: `classifyAndTagMessage` gathers the evidence after the anti-spam switches let it through and passes the flags to `scoreRules` as `ctx.linkFlags`. An account or user with anti-spam off never requests tags. No link rule subtracts, so an unknown source neither raises nor lowers a score. The verdict stores the evidence and the flags as `spam_details.links`, and "Why?" lists the rules that fired from `rulesFired` as before.
- **Training.** `captureManualSpamLabel` and `recordJevSpamVerdict` take the flags when the record is made, from the row as it is then: the same tag request runs alongside the header read and only while anti-spam is on for the message's account and user. They are stored in `flag_features`, and `flagTokensFor` turns a flag of 1 into a model token (`__link_text_domain_mismatch__`, `__link_domain_new__`, `__link_domain_listed__`, `__link_url_unsafe__`); 0 and `null` give none. A retrain reads the stored flags and requests neither tags nor external sources.
- **Bodies at ingest.** New mail is ingested with its body (see message bodies above), so classification at ingest has its links. A row without a stored body (ingested before bodies came with ingest, whose body parts came back empty, or whose part fetch failed) gives `body_unavailable` and the link rules stay silent for it, as `BODY_URL_SHORTENER` does; they apply once its body is stored, such as `ensureSpamVerdict` on mail that was opened or fetched since.

| Path | What |
|---|---|
| `backend/fork-features/link-evidence/index.js` | `linkEvidenceFor`, `linkFlags`, `LINK_LOOKUP_DEADLINE_MS` |
| `backend/fork-features/link-evidence/index.test.js` | Snapshot flag truth tables; current-subject alignment, missing subjects, source states and snapshot-time age boundaries |
| `backend/src/services/spamPipeline.links.test.js` | Four link rules through classification with tag dispatch mocked: firing, unavailable sources recorded without firing or subtracting, no request with anti-spam off |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/services/spamRules.js` | `LINK_TEXT_DOMAIN_MISMATCH`, `LINK_DOMAIN_NEW`, `LINK_DOMAIN_LISTED`, `LINK_URL_UNSAFE` reading `ctx.linkFlags`; `scoreRules` and `explainRules` pass it to the rules |
| `backend/src/services/spamPipeline.js` | Link evidence before the rules; link flags in the flag features and the rule context; `spam_details.links` |
| `backend/src/services/spamModel.js` | Four link flag tokens in `FLAG_TOKENS` and `flagTokensFor` |
| `backend/src/services/spamTraining.js` | The row read includes both anti-spam switches; the link flags join `flag_features` when a record is made |
| `backend/src/services/spamRules.test.js`, `backend/src/services/spamModel.test.js`, `backend/src/services/spamTraining.test.js`, `backend/src/routes/mail.spam.test.js` | Rule weights, link rules and tokens, the training snapshot, no tag request with anti-spam off or in a retrain |

## Jev classification plugin

The plugin `jev-classify` (`backend/src/plugins/jev-classify/`) asks Jev to classify each message of an account, moves INBOX mail to the folder the user mapped its category to (on Gmail it adds the label instead and leaves the message in the inbox), and can hand Jev's confident spam and ham verdicts to anti-spam training. It uses only the plugin API. A user switches it on through plugin activation (Settings → Plugins, or `PATCH /api/plugins/jev-classify`); each account then has its own configuration.

- **Categories** (per user, plugin data `user:<userId>:categories`): `{ revision, categories: [{ id, label, description }] }`, 2–24 entries. Until the user saves a list, the eight defaults (`action-required`, `important-update`, `personal`, `money-and-orders`, `newsletters`, `routine-notifications`, `cold-outreach`, `review`) apply at revision 0. Saving makes the next revision; nothing is re-classified until the user starts a backfill.
- **Markdown input.** Jev reads `getMessageBodyMarkdowns` after body acquisition and applies the existing 8000-Unicode-code-point cap after conversion. A missing document leaves the message untouched; a conversion failure records `body_conversion_failed` as an immediate terminal decision failure, emits a content-free warning and sends no Jev or reputation request for that message. Other messages continue. A legitimately empty cleaned document can still be classified. Existing completed decisions are not automatically reclassified; the normal Retry failed control can requeue terminal failures after a converter change. Markdown may repeat link destinations already present in the structured signals, so conversion alone does not guarantee that the complete state fits the provider's context window.
- **Account configuration** (`plugin_account_config`): `{ enabled, classifyNewMail, newMailFloors, routing, createFolders, trainSpam, routingMinConfidence }`. `routing` maps category ids to folder paths, never INBOX. `newMailFloors` is kept by the server: switching `classifyNewMail` on records each processable folder's UIDVALIDITY and next UID, and mail at or above that UID is new; a folder seen for the first time, or whose UIDVALIDITY changed, gets a fresh floor on the next tick, so history re-ingested after a rebuild is not new mail.
- **Per message** (`plugin_annotations['jev-classify']`): the work queue's `revision` and `queue`, plus a category line `{ decision, action }` and, while `trainSpam` is on, a spam line `{ decision, training }`, each segment a `kind`-tagged state as K9 in [mouriya-s-lab/mailflow#5](https://github.com/mouriya-s-lab/mailflow/issues/5) defines them. A finished action is `{ kind: 'done', target, effect: 'moved' | 'labeled' }`. The queue state is derived from the segments on every write.
- **One attempt** asks Jev once, only the questions still open (category as `choice` over the user's `id → description`, spam as `noul`). Before asking, the tick has the body of every message it will ask about stored with `ensureMessageBodies`; a message is asked only when its body is `stored`, `fetched` or `empty` on the server (then the state has its headers alone), so Jev never receives a state whose body could not be had. The state sent is the message signals, per-link tag evidence from `ensureMessageTags` and the first 8000 Unicode code points of the cleaned Markdown document described above; attachments go only as names and types. `linkDomains[domain]` holds RDAP, Spamhaus DBL and URLhaus TagStates; `linkUrls[digest]` holds the host and Safe Browsing TagState without duplicating the URL (the existing signals still contain `href`). Complete snapshots retain `checkedAt` and only the matching subject, or empty subjects when current links are absent from the snapshot; inactive, unconfigured and plugin-failed states remain explicit. Then training: probability ≥ 0.9 is recorded as spam, ≤ 0.1 as ham, anything between is `below_threshold`. Then the action, for INBOX mail only: a message outside INBOX is `skipped not_in_inbox`; anti-spam's verdict is asked with `ensureSpamVerdict`, and spam (or a user's spam mark) is skipped; then a confidence under `routingMinConfidence` and a category without a folder are skipped; otherwise the message is moved with `moveMessagesVerified` or labelled with `applyLabel`. With `createFolders` the target folder is created and synced once first. Everything the attempt changed is written back with one annotation write. A row deleted or replaced during the attempt drops its result; the replacement carries the marked annotation and is worked again.
- **Failures.** An unconfigured Jev changes nothing and stops the tick's Jev questions. A body that could not be had (`unavailable` with `provider_refusing`, `imap_error` or `message_missing`) is not asked about: its asked decisions retry as `body_unavailable`. A message whose body fetch or tag source returns `unavailable { deadline }` stays queued as it is, spending no attempt and receiving no annotation write or Jev question; a thrown tag dispatcher call retries as `reputation_error`. A timeout, network failure, rate limit or 5xx retries the asked decisions; an invalid request or response or a 4xx fails them for good, with a warning. A segment gets 5 attempts, waiting 2, 4, 8 and 16 minutes between them. A move the server made but MailFlow could not locate (`moved_unlocated`) fails the action for good and is added to the account's incident list (`account:<accountId>:incidents`), which stays until the user clears it.
- **The tick** runs every 60 seconds for every connected account, one at a time per account; new INBOX mail also schedules one at once. It reads activation and configuration each time, marks new mail, and while a backfill runs (`account:<accountId>:backfill`) marks the next 50 messages not at the current revision once the previous batch is worked off. A backfill completes when nothing is left to mark and none of its messages waits for a retry. Then it works through at most 50 queued messages, new mail first, starting none once less than 5 seconds of its 60-second budget is left; the time left is the deadline for the body fetch, the signal read, the reputation lookup and Jev. Training records, moves and labels have no deadline. A tick that recorded training asks for one retrain of the user. A disabled account is not marked or worked, keeps its queue, and its backfill stays running.
- **HTTP** (`/api/jev-classify`, signed-in user only, own data only; an invalid body is a 400 with `fields` and writes nothing): `GET`/`PUT /categories`; `GET /accounts` (configuration, new-mail floors, processable folders, whether the account is label-store); `PUT /accounts/:id` (switching `trainSpam` on also puts back in the queue every message whose spam line was switched off, as soon as the account's running tick is over; the response does not wait for it, and the next tick decides them); `POST`/`DELETE /accounts/:id/backfill` (start, 409 when running or ineligible, with `reason` for eligibility refusals; a new run requires an enabled IMAP account, current plugin activation, the account's module enabled and configured Jev; stop, 409 when not running; messages already marked are still worked); `GET /status`; `POST /accounts/:id/retry-failed` (every `terminal_failed` segment back to its start, a segment skipped because its decision failed back to waiting on it); `DELETE /accounts/:id/incidents`. An account of another user is a 404.
- **Status** returns `{ activated, jev, reputation, accounts }`, with `jev` the Jev service's status and `reputation` `{ rdap, spamhaus_dbl, urlhaus, safe_browsing }`, each entry `{ pluginId, activated, configuration }`: the registered owning plugin's activation and the source's `sourceStatus` independently, and per account: `state` (`enabled`, or `paused` when the plugin is not activated or the account is disabled), queue counts per origin, `nextDue` (`none`, `due_now` or `scheduled` with the earliest retry time), `terminalFailed`, the backfill run, `lastDecidedAt` (`account:<accountId>:stats`), the Jev requests this process sent for the account, and the incidents.
- **Settings page** (`frontend/src/plugins/jev-classify/`): once the plugin is activated, Settings → Categories shows a Jev classification block after GTD's, and the Plugins tab links to it. It shows whether Jev is configured (a notice when it is not), the state of each link reputation source, and an editor for the categories: name and description per row, 2–24 rows, checked against the server's rules before anything is sent, so a too short or too long list, an empty name or an empty description is shown at its field and not saved. A new row gets its id from its name (ASCII letters and digits, `-` between words, `-2`, `-3`… when taken); a saved row keeps its id. Per account it edits the six settings and saves them with one `PUT`: the target of each category is chosen from that account's processable folders (labels on Gmail) without INBOX in any case, a stored target the account no longer offers blocks the save until another is chosen, and routes of deleted categories are dropped. Below them it shows the account's run state (`enabled`/`paused`), the backfill run with Start and Stop, the queue per origin, the next retry, the last classification and the Jev requests, terminal failures with Retry failed, and the incidents with Clear list. The status is fetched when the block opens, every 15 seconds and after every action; only the newest answer is shown. The configuration being edited is replaced only by what a save returns, never by the status refresh.
- The tick, its single flight and the locks that keep the routes and the tick from overwriting each other's configuration and backfill writes are in-process, which holds while one backend process serves the installation. Plugin data is deleted with the user.

| Path | What |
|---|---|
| `backend/src/plugins/jev-classify/index.js` | Manifest: router, `inboxIngest` hook, sync tick |
| `backend/src/plugins/jev-classify/model.js` | Parsers of everything stored or received, the per-message state machine, the Jev request |
| `backend/src/plugins/jev-classify/records.js` | Plugin data and account configuration reads and serialized writes |
| `backend/src/plugins/jev-classify/processor.js` | The tick: marking, the attempt per message, backfill progress; re-queuing switched-off spam lines |
| `backend/src/plugins/jev-classify/routes.js` | The `/api/jev-classify` endpoints |
| `backend/src/plugins/jev-classify/backfill.js` | Owner-scoped eligibility, inspection and serialized start shared by single-account and bulk entry points |
| `backend/src/plugins/jev-classify/*.test.js` | The tick against a mocked plugin API; the endpoints over HTTP |
| `frontend/src/plugins/jev-classify/index.jsx` | Registers the settings block in the `settings-categories` slot and the plugin's settings location |
| `frontend/src/plugins/jev-classify/JevClassifySettings.jsx` | The settings block: services, categories, account settings and running state |
| `frontend/src/plugins/jev-classify/model.js` | The category and account forms and their parse into request bodies |
| `frontend/src/plugins/jev-classify/api.js` | `jevClassifyApi`: the `/api/jev-classify` calls |
| `frontend/src/plugins/jev-classify/JevClassifySettings.render.test.js` | Render test against a fake API: activation gating, unconfigured Jev, retry failed, clear incidents, field errors, targets and request bodies, backfill, the 15-second refresh |
| `backend/migrations/9005_fork_jev_classify_queue_indexes.sql` | Two partial indexes on the plugin's queue in `messages.plugin_annotations`; adds indexes only |

### Patches to upstream files (re-check on every upstream sync)

| File | Change |
|---|---|
| `backend/src/plugins/loadPlugins.js` | Registers `jevClassifyPlugin` after GTD |
| `frontend/src/plugins/index.js` | Imports `./jev-classify/index.jsx` after GTD |
| `frontend/src/locales/*.json` | `jevClassify.*` strings |

An account whose plugin is active for `inboxIngest` also counts as keeping label siblings in `routes/mail.js` (`accountMaintainsLabelSiblings`), so marking such an account's message read or starred also updates its other copies with the same Message-ID in that account.
