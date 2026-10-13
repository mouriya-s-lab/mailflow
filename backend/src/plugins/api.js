// The plugin API surface — the ONLY module a sandboxed (Tier-2) plugin is allowed to import
// from (v3.0 plugin platform).
//
// Everything a plugin may safely do lives here, re-exported from core so plugins never reach
// into core internals directly (no raw `db.js`/`query`, no `imapManager`, no service files). This
// is the boundary the enforcement lint rule guards: a plugin directory may import from './api.js'
// (this file) and its own siblings, and nothing else under src/.
//
// Tiers: a Tier-1 (trusted, in-repo) plugin like GTD may currently still import core directly
// while we migrate it onto this surface; the goal is that GTD ends up importing ONLY from here,
// at which point it — and any third-party plugin — can be owned and changed without a core
// security review. This module grows as capabilities are proven safe and GTD is moved onto them.
//
// What's intentionally NOT here (and never will be): the database handle, the IMAP/mail engine,
// other users' data, the Express app, filesystem/network. Mail actions are exposed only as narrow,
// pre-bound capabilities (apply a label, summarize a message, …), never as the raw manager.

import { getMailEngine } from './mailEngine.js';
import * as labelsWrite from '../services/labels.js';
import { archiveInboxCopy as _archiveInboxCopy } from '../services/archiveInbox.js';
import { decide as decideJev, status as jevConfigStatus } from '../../fork-features/jev/index.js';
import { loadJevConfig } from '../../fork-features/service-config/index.js';
import { moveMessagesVerified as _moveMessagesVerified } from '../../fork-features/verified-move/index.js';
import { ensureMessageBodies as _ensureMessageBodies } from '../../fork-features/message-bodies/index.js';

// ── Labels (read) ─────────────────────────────────────────────────────────────
// Thread-aware read over a set of label folders: heads grouped by label with thread-level
// unread/union counts. See services/labelsRead.js for the correctness contract.
export { listThreadHeadsByLabels } from '../services/labelsRead.js';

// "Did an ordinary mail mutation touch one of my labelled threads?" → scoped user broadcast.
export { notifyOnLabelTouch } from '../services/labelsRead.js';

// Verify a physical copy's live RFC Message-ID before it authorizes another deletion.
export const hasMessageCopy = (account, uid, folder, messageId) => getMailEngine().hasMessageCopy(account, uid, folder, messageId);
export const isLabelStoreAccount = (account) => getMailEngine().isLabelStore(account);

// ── Labels (write) ────────────────────────────────────────────────────────────
// Apply/remove a label (a message copy in a label folder) and mark a thread read. The mail
// engine is bound in by the platform (getMailEngine) so a plugin performs these mail actions
// without ever holding the engine itself. resolveLabelCopyUid is pure (no engine).
export const applyLabel = (account, message, labelFolder, options) => labelsWrite.applyLabel(getMailEngine(), account, message, labelFolder, options);
export const removeLabel = (message, labelFolder) => labelsWrite.removeLabel(getMailEngine(), message, labelFolder);
export const removeExactLabelCopy = (message, labelFolder, uid) => labelsWrite.removeExactLabelCopy(getMailEngine(), message, labelFolder, uid);
export const markThreadRead = (account, message) => labelsWrite.markThreadRead(getMailEngine(), account, message);
export const markCopySeen = (account, message) => labelsWrite.markCopySeen(getMailEngine(), account, message);
export const ensureLabelFolders = (account, folderPaths) => labelsWrite.ensureLabelFolders(getMailEngine(), account, folderPaths);
export const resolveLabelCopyUid = labelsWrite.resolveLabelCopyUid;

// ── Archive ───────────────────────────────────────────────────────────────────
// Archive a message's INBOX copy (used by GTD "done"). Engine bound by the platform.
export const archiveInboxCopy = (account, inboxCopy, fromFolder) => _archiveInboxCopy(getMailEngine(), account, inboxCopy, fromFolder);

// ── Realtime broadcast ────────────────────────────────────────────────────────
// Push a payload to a specific user's live sessions. A plugin can notify its own clients; it
// cannot address other users or subsystems (the engine + user scoping are enforced here).
export const broadcast = (payload, userId) => getMailEngine().broadcast(payload, userId);

// ── Summarize ─────────────────────────────────────────────────────────────────
// Condense a message into one line via the configured AI provider (fails closed when the
// provider is off / the summarize feature is disabled). No access to keys or the provider itself.
export { summarizeMessage, summarizeAvailable } from '../services/summarize.js';

// ── Jev decisions ─────────────────────────────────────────────────────────────
// Ask the Jev endpoint the admin configured typed questions about a state; typed answers or a typed
// error come back (fork-only, see fork-features/jev). The configuration is read from the admin
// setting on every call, so both are async. No access to the key or the HTTP client itself.
export const jevDecide = async (request, options) => decideJev(await loadJevConfig(), request, options);
export const jevStatus = async () => jevConfigStatus(await loadJevConfig());

// ── Link reputation ───────────────────────────────────────────────────────────
// One lookup per source, each asking only its own service from the settings the admin saved
// (fork-only, see fork-features/reputation): RDAP registration dates, Spamhaus DBL and URLhaus
// verdicts for registrable domains, Safe Browsing verdicts for link URLs, and each source's status.
// A failed lookup is `unknown`, never "not listed"; a link itself is never fetched.
export {
  lookupRdap, lookupSpamhausDbl, lookupUrlhaus, lookupSafeBrowsing, sourceStatus,
} from '../../fork-features/reputation/index.js';

// ── Anti-spam ─────────────────────────────────────────────────────────────────
// Feed Jev's spam/ham verdicts into a user's training records, ask for a retrain, and ask
// for a message's anti-spam verdict (classified on the spot when it has none yet, never
// moved). Fork-only; see backend/fork-features/README.md. Typed `kind` results.
export { recordJevSpamVerdict, requestSpamRetrain } from '../services/spamTraining.js';
export { ensureSpamVerdict } from '../services/spamPipeline.js';

// ── Work queue and verified move ──────────────────────────────────────────────
// A plugin's per-message annotations as a durable work queue (`revision` and `queue` in its
// namespace), and a move that first proves on the server, in the same session, that each row is
// still the message it names (fork-only, see fork-features/work-queue and verified-move). Label-
// store accounts (Gmail) are not moved; plugins label them with applyLabel.
export { markMessages, currentUidFloors, listQueuedMessages, listMessagesInQueueState, countQueued } from '../../fork-features/work-queue/index.js';
export const moveMessagesVerified = (args) => _moveMessagesVerified(getMailEngine(), args);

// ── Message signals ───────────────────────────────────────────────────────────
// getMessageSignals(accountId, ids, { deadlineMs }) → Map<id, MessageSignals>: sender, recipients,
// trusted authentication, links shown versus where they go, attachments, mailing-list marks and
// language of the account's messages (fork-only, see fork-features/signals). An id that is not a
// message of the account is absent from the Map. getMessageBodyTexts(accountId, ids) → Map<id,
// string>: the body as text (body_text, or the visible text of body_html), same scoping.
export {
  getAccountMessageSignals as getMessageSignals,
  getAccountMessageBodyTexts as getMessageBodyTexts,
} from '../../fork-features/signals/index.js';

// ensureMessageBodies(accountId, ids, { deadlineMs }) → Map<id, BodyOutcome>: makes sure each of
// the account's messages has its body stored before it is judged, fetching a missing one from the
// server by its folder and UID and storing it only on a row that still has none. `stored`,
// `fetched`, `empty` (the server has no renderable body) or `unavailable { reason }` with
// 'provider_refusing' (stops the batch), 'imap_error', 'message_missing' or 'deadline'
// (fork-only, see fork-features/message-bodies).
export const ensureMessageBodies = (accountId, ids, options) => _ensureMessageBodies(getMailEngine(), accountId, ids, options);

// ── Per-plugin storage ────────────────────────────────────────────────────────
// Generic per-plugin key/value + blob storage (the plugin_data table), owner-scoped and cascade-
// cleaned. A plugin can persist its own data without a schema migration or DB access.
export * as storage from './storage.js';

// ── Logging ───────────────────────────────────────────────────────────────────
// Structured logger. A plugin may log; it cannot reach the transport or other subsystems.
export { logger } from '../services/logger.js';

// ── Auth ──────────────────────────────────────────────────────────────────────
// Express middleware to require an authenticated session on a plugin's own routes.
export { requireAuth } from '../middleware/auth.js';

// ── Activation ────────────────────────────────────────────────────────────────
// Whether a plugin is activated for a user (per-user, from preferences). A plugin composes this
// with its own config to decide whether it is effectively on for an account.
export { isPluginActivated, isPluginActivatedForAccount } from './activation.js';

// ── Per-account plugin config ───────────────────────────────────────────────────
// A plugin's own configuration for one account (opaque blob), cascade-cleaned with the account.
export { getAccountConfig, setAccountConfig } from './accountConfig.js';

// ── Folder resolution ─────────────────────────────────────────────────────────
// Resolve an account's Drafts, Trash and Junk paths (across provider naming). A safe read over the
// account's folder mapping — no mail engine, no raw DB.
export { resolveAllDraftsPaths, resolveAllTrashPaths, resolveAllSpamPaths } from '../utils/mailUtils.js';

// ── Mail/account reads ────────────────────────────────────────────────────────
// A fixed, reviewed set of ownership-scoped read queries (see services/mailAccess.js). A plugin
// reads mail/account data only through these — never raw SQL, never across users.
export {
  loadOwnedMessage,
  getOwnedAccount,
  listUserAccounts,
  getAccountAddresses,
  getThreadKeysForMessageIds,
  getThreadKeysInFolders,
  getThreadKeysForMessageIdHeaders,
  getMessagesByThreadKeys,
  getThreadKeyForUid,
  getMessageCopyFolders,
  getMessageFields,
  getMessageAnnotations,
  setMessageAnnotation,
} from '../services/mailAccess.js';
