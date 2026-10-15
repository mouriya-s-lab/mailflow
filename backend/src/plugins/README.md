# MailFlow plugins

MailFlow features can live as **plugins**: self-contained modules that talk to core only through a
fixed, reviewed capability surface. **GTD** (`gtd/`) is the reference plugin and the first fully
extracted one.

The point of the boundary is trust: a plugin **cannot** reach into core, the mail engine, the
database, the network, or other users' data — so a plugin change can be reviewed for *feature
correctness*, not for whether it could compromise the app. That's what lets a contributor own a
plugin without a deep security review of every PR.

Two tiers (conceptual): **Tier-1** = trusted, in-repo (like GTD today); **Tier-2** = untrusted /
third-party. Both use the *same* capability surface — GTD was migrated fully onto it so the surface
is proven.

---

## Where things live

| | Path |
|---|---|
| Backend plugin code | `backend/src/plugins/<name>/` |
| Backend capability surface (the ONLY core import a plugin may use) | `backend/src/plugins/api.js` |
| Import-boundary lint rule | `backend/eslint.plugins-boundary.js` (`npm run lint:plugins`) |
| Frontend plugin code | `frontend/src/plugins/<name>/` |
| Frontend slot registry | `frontend/src/plugins/registry.js`, `PluginSlot.jsx`, `events.js` |

---

## Backend

### The rule

A file under `src/plugins/<name>/` may import **only**:
- `../api.js` (the capability surface), and
- its own siblings inside `src/plugins/<name>/`.

It may **not** import `../../services`, `../../utils`, `../../routes`, `../../middleware`,
`../../index`, or platform internals (`../registry.js`, `../storage.js`, …). This is enforced by
`eslint.plugins-boundary.js`. At runtime a plugin's hooks receive a **bounded engine facade**
(`mailEngineFacade.js`), never the raw mail engine.

Run it locally:

```bash
cd backend
npm run lint:plugins   # boundary check — must be 0 violations
npm run lint           # normal lint
npm test               # full suite
```

### Capability surface (`api.js`)

Everything a plugin may do, grouped:

- **Labels (read):** `listThreadHeadsByLabels`, `notifyOnLabelTouch`, `hasMessageCopy` (checks one copy on the server), `isLabelStoreAccount` (Gmail: folders are labels)
- **Labels (write):** `applyLabel`, `removeLabel`, `markThreadRead`, `markCopySeen`, `ensureLabelFolders`, `resolveLabelCopyUid`
- **Archive:** `archiveInboxCopy`
- **Realtime:** `broadcast` (scoped to one user)
- **Summarize:** `summarizeMessage`, `summarizeAvailable` (fails closed when the AI provider is off)
- **Jev decisions (fork-only):** `jevDecide`, `jevStatus` (async; use the Jev settings an admin saved; typed answers or a typed error; see `backend/fork-features/README.md`)
- **Link reputation (fork-only):** `lookupRdap`, `lookupSpamhausDbl`, `lookupUrlhaus`, `lookupSafeBrowsing`, `sourceStatus` (async; one function per source, each asking only its own service; a failed lookup is `unknown`), and `reputationUrlSubject(url)` (pure; the K6 canonical URL's SHA-256 digest and link host, without retaining its path or query); see `backend/fork-features/README.md`
- **Anti-spam (fork-only):** `recordJevSpamVerdict`, `requestSpamRetrain`, `ensureSpamVerdict` (Jev verdicts as training records, a per-user retrain, a message's verdict classified on demand; typed `kind` results; see `backend/fork-features/README.md`)
- **Message signals (fork-only):** `getMessageSignals(accountId, ids, { deadlineMs })` (async; sender, recipients, trusted authentication, links, attachments, mailing-list marks and language), `getMessageBodyTexts(accountId, ids)` (the stored body as text), `getMessageLinks(accountId, ids)` (stored HTML links only; no header fetch or IMAP); see `backend/fork-features/README.md`
- **Message bodies (fork-only):** `ensureMessageBodies(accountId, ids, { deadlineMs })` (async; fetches and stores the body of each of the account's messages that has none yet, never overwriting a stored one; per message `stored`, `fetched`, `empty` or `unavailable { reason }`, and a provider refusal stops the batch); see `backend/fork-features/README.md`
- **Message tags (fork-only):** `ensureMessageTags(accountId, ids, { deadlineMs })` synchronously asks activated, configured tag sources; `getMessageTags(accountId, ids)` only reads their snapshots. Both scope messages to the account and explicitly distinguish inactive, unconfigured, unchecked (read only), complete and unavailable states; see `backend/fork-features/README.md`
- **Stored result inspection (fork-only):** `readJevSpamResults`, `readJevSpamMessage`, `readReputationResults`, `readReputationMessage` (fixed ownership-scoped database reads, independent from current activation; counts and a page share one SQL snapshot). These validate only the documented public read projection; owners parse their private state and produce whitelisted observations. No source call, classification, ensure or write; see `backend/fork-features/README.md`.
- **Per-plugin storage:** `storage.*` (the `plugin_data` table — KV + blobs, owner-scoped, cascade-cleaned)
- **Per-account plugin config:** `getAccountConfig`, `setAccountConfig` (the `plugin_account_config` table)
- **Per-message annotations:** `getMessageAnnotations`, `setMessageAnnotation` (namespaced `messages.plugin_annotations`; the write resolves to `{ kind: 'written' }` or `{ kind: 'message_missing' }`)
- **Work queue and verified move (fork-only):** `markMessages`, `currentUidFloors`, `listQueuedMessages`, `listMessagesInQueueState`, `countQueued` (a plugin's annotations as a durable work queue), `moveMessagesVerified` (moves only what the server confirms is the same message; not for label-store accounts); see `backend/fork-features/README.md`
- **Activation:** `isPluginActivated`, `isPluginActivatedForAccount`
- **Logging:** `logger` · **Auth middleware:** `requireAuth` · **Folder resolution:** `resolveAllDraftsPaths`, `resolveAllTrashPaths`, `resolveAllSpamPaths`
- **Ownership-scoped mail/account reads:** `loadOwnedMessage`, `getOwnedAccount`, `listUserAccounts`, `getAccountAddresses`, `getMessagesByThreadKeys`, `getMessageCopyFolders`, `getMessageFields`, the thread-key resolvers, …

If you need something not here, **don't reach around the boundary** — ask, and we add a reviewed
capability to `api.js`. That's a small, deliberate core change; the boundary stays intact.

### Manifest + registration

A plugin exports a manifest (see `gtd/index.js`): `{ id, name, version, tier, router?, hooks?, sync?, tagSource?, backfill? }`.
Core mounts the router and fires the hooks through the registry — core never calls a plugin directly.
`hooks` are the plugin's halves of generic core events (e.g. `inboxIngest`, `afterLabelCopy`,
`onSentMessage`, `validateAccountSettings`, `enrichAccount`, …); `sync` is an optional periodic tick.
`tagSource` is `{ source, ensure(accountId, ids, { deadlineMs }), read(accountId, ids) }`.
Its functions return a `Map` covering the requested ids with typed tag states; registry registration
rejects duplicate source ownership or malformed declarations.
The fork's optional `backfill` capability is `{ inspect(userId, accountId), start(userId, accountId) }`.
The owner checks account ownership before reading private records and confirms start eligibility
from current activation, account/module configuration and service configuration. `inspect`
returns `{ kind: 'available', eligibility, backfill }`; eligibility is `ready` or
`skipped { reason }`. `start` returns `started { backfill }`, `already_running { backfill }`
or `skipped { reason }`, acknowledging `started` only after its existing run is persisted.
Unexpected failures throw. Both functions are required when declaring the capability.
The shared `/api/plugins/backfill` router discovers these capabilities through the registry;
it neither knows plugin ids nor owns another run.

### Data

No plugin-specific columns/tables in core. Plugin data lives in generic stores: `plugin_data`
(KV/blobs), `plugin_account_config` (per-account config), `messages.plugin_annotations` (per-message,
namespaced by plugin id). All cascade-clean with their owner.

### Bundled reputation tags

`reputation-tags/` exports four independent manifests: `tag-rdap`, `tag-spamhaus`, `tag-urlhaus`
and `tag-safebrowsing`. They share only implementation, not activation, message namespaces, UID
floors, backfill records or single-flight turns (`pluginId:accountId`). Activation is per user;
there are no per-account settings. The account config contains only server-maintained UID floors.

Each signed-in user's plugin router (`/api/<pluginId>`) provides `GET /status` and
`POST`/`DELETE /accounts/:id/backfill`. Starting an already running backfill, stopping one
that is not running, or starting an ineligible account returns 409; eligibility refusals
include `reason`. Another user's account is 404. Status reads no external source.
Stopping prevents another batch from being marked; previously queued messages still finish and
increment `processed`, while the backfill state remains `stopped`.

The interval tick and `inboxIngest` wake-up use the existing Jev budgets and retry policy. A first
activated tick establishes new-mail floors, including when a source has no key; unconfigured or
disabled sources write no message annotation. A tag snapshot contains `checkedAt` and source-native
subjects. Unknown answers are saved immediately and kept in retry until success or five attempts;
body unavailability leaves the queue untouched. Safe Browsing stores only a canonical URL digest,
host and verdict, never the original URL. Details and storage layout are in
`backend/fork-features/README.md`.
The hook's last-tick activation-and-configuration gate is an in-memory read, so merely registering
the plugins does not enable the core's label-sibling read/star fan-out for inactive accounts.
Both read and ensure check current activation and source configuration before reading annotations:
inactive or unconfigured sources hide existing snapshots without deleting them, so disabled sources
cannot contribute summary chips.

Stored inspection is separate from `tagSource.read`/`ensure`: `GET /results` and
`GET /results/:messageId` under each of the four routers retain saved results while inactive
or unconfigured. The Jev router exposes the same inspection endpoints for its spam line.
Counts represent current live physical mail rows, not request totals or a backfill's progress;
folder/label copies count separately and facets can overlap. Saved revision and current
activation/configuration are shown separately; inspection never restores live chip eligibility.

---

## Frontend

Plugins register into a small in-process registry (imported once at startup via
`frontend/src/plugins/index.js`). Runtime effects and feature slots are activation-gated
on `store.enabledPlugins`; static metadata and saved-result inspection remain available
when a plugin is disabled:

- `registerSlot(name, { pluginId, isActive?, render })` — render UI at a core seam (`right-sidebar`,
  `settings-categories`, `row-hover-action`, …). Rendered with `<PluginSlot>` / `usePluginSlot`.
- `registerCollector(name, { pluginId, build })` — contribute descriptor arrays core renders with its
  own chrome (e.g. context-menu items). Read with `usePluginCollected`.
- `registerRuntime({ pluginId, component })` — a headless component (renders null) that runs
  background effects/subscriptions only while the plugin is activated.
- `registerWsHandler(type, { pluginId, handler })` / `registerReconnectHandler(...)` — handle WS
  message types core doesn't, and resync on reconnect.
- `registerPluginMeta(pluginId, meta)` — static metadata (e.g. where the plugin's settings live).
  Bundled Jev and reputation plugins declare `hasStoredResults: true`; the shared Plugins tab
  renders their read-only result entry without turning the plugin on.

**Caveat — the one place core still knows about GTD:** the inbox pill-tab strip (Inbox/Todo/Waiting/…)
in `MessageList.jsx` is interleaved with the core *category* tabs (shared tab strip + active-tab
state + list-body swap), so it isn't behind a slot yet. Changes there still touch core. Everything
else (right sidebar, context menu, row actions, settings, WS, the sections fetch) is fully behind the
registry. There's no import-boundary lint on the frontend — but a frontend plugin's blast radius is
one user's own browser (never the server or other users), so it's reviewed lightly.

The fork's shared result viewer lives in `frontend/fork-features/plugin-results/`.
Core's mail presentation seams mount its Jev saved-detail component and the existing live
four-source summaries in normal, conversation and detached views. Opening a result uses its
exact physical UUID with a transient single-message selection, not a Message-ID recovery
or a persisted conversation-mode change.

---

## Contributing to a plugin

- Work inside `plugins/<name>/`. Keep `npm run lint:plugins` at 0 violations.
- Need a new capability? Open an issue/PR describing it — core adds it to `api.js`.
- GTD is per-user opt-in (Settings → Plugins), off by default.
