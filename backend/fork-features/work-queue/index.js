// Plugin work queue over message annotations (K7, mouriya-s-lab/mailflow#13).
//
// A plugin keeps its per-message work state in its own plugin_annotations namespace. This module
// owns two fields of that namespace, `revision` and `queue = { state, dueAt, origin }`, and never
// touches the plugin's other fields. The annotation travels with its row when a user move
// relocates the message (RELOCATE_COPY_COLS, insertCopiedSibling), so the queue needs no table of
// its own. Like the reads in services/mailAccess.js, every function is scoped to one account the
// caller has already established it owns.

import { query } from '../../src/services/db.js';
import { resolveAllDraftsPaths, resolveAllTrashPaths, resolveSentFolder } from '../../src/utils/mailUtils.js';

export const QUEUE_STATES = Object.freeze(['pending', 'retry', 'done', 'terminal']);
export const QUEUE_ORIGINS = Object.freeze(['backfill', 'new_mail']);
export const MAX_LIST_LIMIT = 200;

const isCount = value => Number.isSafeInteger(value) && value >= 0;

function parseCommon({ accountId, pluginId }) {
  if (typeof accountId !== 'string' || !accountId) throw new TypeError('accountId must be a non-empty string');
  if (typeof pluginId !== 'string' || !pluginId) throw new TypeError('pluginId must be a non-empty string');
  return { accountId, pluginId };
}

function parseOrigin(origin) {
  if (!QUEUE_ORIGINS.includes(origin)) throw new TypeError(`origin must be one of ${QUEUE_ORIGINS.join(', ')}`);
  return origin;
}

function parseLimit(limit, max = Infinity) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  return Math.min(limit, max);
}

// scope: { kind: 'not_at_revision' } | { kind: 'above_uid_floor', floors: Record<folder, { uidValidity, nextUid }> }
function parseScope(scope) {
  switch (scope?.kind) {
    case 'not_at_revision':
      return { kind: 'not_at_revision' };
    case 'above_uid_floor': {
      if (!scope.floors || typeof scope.floors !== 'object' || Array.isArray(scope.floors)) {
        throw new TypeError('above_uid_floor needs floors: Record<folder, { uidValidity, nextUid }>');
      }
      const floors = Object.entries(scope.floors).map(([path, floor]) => {
        if (!isCount(floor?.uidValidity) || !isCount(floor?.nextUid)) {
          throw new TypeError(`floor of folder ${JSON.stringify(path)} needs integer uidValidity and nextUid`);
        }
        return { path, uidValidity: floor.uidValidity, nextUid: floor.nextUid };
      });
      return { kind: 'above_uid_floor', floors };
    }
    default:
      throw new TypeError("scope.kind must be 'not_at_revision' or 'above_uid_floor'");
  }
}

// The account's Sent, Drafts and Trash folders, by its folder mappings and special-use flags, as
// the rest of MailFlow resolves them. Their messages are never marked or given a floor.
async function excludedFolders(accountId) {
  const { rows: [account] } = await query('SELECT folder_mappings FROM email_accounts WHERE id = $1', [accountId]);
  const mappings = account?.folder_mappings ?? null;
  const [trash, drafts, sent] = await Promise.all([
    resolveAllTrashPaths(accountId, mappings),
    resolveAllDraftsPaths(accountId, mappings),
    resolveSentFolder(accountId, mappings),
  ]);
  return [...new Set([...trash, ...drafts, ...(sent ? [sent] : [])])];
}

// The plugin's namespace with `revision` and a fresh pending `queue`, every other field kept.
const MARKED_ANNOTATIONS = `jsonb_set(
  COALESCE(m.plugin_annotations, '{}'::jsonb), ARRAY[$2::text],
  COALESCE(m.plugin_annotations -> $2, '{}'::jsonb)
    || jsonb_build_object('revision', $3::bigint,
                          'queue', jsonb_build_object('state', 'pending', 'dueAt', NULL, 'origin', $4::text)),
  true)`;

// markMessages({ accountId, pluginId, scope, revision, origin, limit }) → number of rows marked.
//
// One UPDATE marks up to `limit` processable rows (not flagged deleted, not in Sent/Drafts/Trash)
// that match the scope. The id subquery only picks the batch; the outer WHERE repeats every
// condition so a row a concurrent writer changed after the pick is checked again before it is
// written, and the returned count is exactly the rows written.
export async function markMessages(args) {
  const { accountId, pluginId } = parseCommon(args);
  const scope = parseScope(args.scope);
  if (!isCount(args.revision)) throw new TypeError('revision must be a non-negative integer');
  const origin = parseOrigin(args.origin);
  const limit = parseLimit(args.limit);
  const excluded = await excludedFolders(accountId);

  switch (scope.kind) {
    case 'not_at_revision': {
      const matches = alias => `${alias}.account_id = $1 AND ${alias}.is_deleted = false
        AND ${alias}.folder <> ALL($5::text[])
        AND (${alias}.plugin_annotations -> $2 -> 'revision') IS DISTINCT FROM to_jsonb($3::bigint)`;
      const { rowCount } = await query(
        `UPDATE messages m SET plugin_annotations = ${MARKED_ANNOTATIONS}
          WHERE m.id IN (SELECT c.id FROM messages c WHERE ${matches('c')} LIMIT $6)
            AND ${matches('m')}`,
        [accountId, pluginId, args.revision, origin, excluded, limit],
      );
      return rowCount;
    }
    case 'above_uid_floor': {
      // UIDs are assigned by the server and only grow within one UIDVALIDITY, so a UID at or
      // above the floor taken under the folder's current UIDVALIDITY is mail that entered the
      // folder after the floor. A folder whose UIDVALIDITY changed since has no comparable UIDs
      // and marks nothing.
      const matches = alias => `${alias}.account_id = $1 AND ${alias}.is_deleted = false
        AND ${alias}.folder <> ALL($5::text[])
        AND NOT (COALESCE(${alias}.plugin_annotations, '{}'::jsonb) ? $2)
        AND EXISTS (
          SELECT 1 FROM unnest($6::text[], $7::bigint[], $8::bigint[]) AS fl(path, uid_validity, next_uid)
            JOIN folders f ON f.account_id = ${alias}.account_id AND f.path = fl.path AND f.uid_validity = fl.uid_validity
           WHERE fl.path = ${alias}.folder AND ${alias}.uid >= fl.next_uid)`;
      const { rowCount } = await query(
        `UPDATE messages m SET plugin_annotations = ${MARKED_ANNOTATIONS}
          WHERE m.id IN (SELECT c.id FROM messages c WHERE ${matches('c')} LIMIT $9)
            AND ${matches('m')}`,
        [
          accountId, pluginId, args.revision, origin, excluded,
          scope.floors.map(f => f.path), scope.floors.map(f => f.uidValidity), scope.floors.map(f => f.nextUid),
          limit,
        ],
      );
      return rowCount;
    }
    default:
      throw new Error(`unhandled scope ${scope.kind}`);
  }
}

// currentUidFloors({ accountId }) → Record<folder, { uidValidity, nextUid }> for every processable
// folder with a known UIDVALIDITY; nextUid is one past the highest UID MailFlow holds for the
// folder, or 1 when it holds none.
export async function currentUidFloors({ accountId } = {}) {
  if (typeof accountId !== 'string' || !accountId) throw new TypeError('accountId must be a non-empty string');
  const excluded = await excludedFolders(accountId);
  const { rows } = await query(
    `SELECT f.path, f.uid_validity, COALESCE(MAX(m.uid), 0) + 1 AS next_uid
       FROM folders f
       LEFT JOIN messages m ON m.account_id = f.account_id AND m.folder = f.path
      WHERE f.account_id = $1 AND f.uid_validity IS NOT NULL AND f.path <> ALL($2::text[])
      GROUP BY f.path, f.uid_validity`,
    [accountId, excluded],
  );
  return Object.fromEntries(rows.map(row => [row.path, { uidValidity: Number(row.uid_validity), nextUid: Number(row.next_uid) }]));
}

// listQueuedMessages({ accountId, pluginId, now, limit }) → rows whose queue is pending, or retry
// and due by `now`, earliest dueAt first (pending, with no dueAt, ahead of all), then by id.
export async function listQueuedMessages(args) {
  const { accountId, pluginId } = parseCommon(args);
  const now = args.now instanceof Date ? args.now : new Date(args.now);
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a Date or an ISO 8601 timestamp');
  const limit = parseLimit(args.limit, MAX_LIST_LIMIT);
  const { rows } = await query(
    `SELECT id, folder, uid, message_id, date, synced_at, plugin_annotations -> $2 AS plugin_annotation
       FROM messages
      WHERE account_id = $1
        AND (plugin_annotations -> $2 -> 'queue' ->> 'state' = 'pending'
             OR (plugin_annotations -> $2 -> 'queue' ->> 'state' = 'retry'
                 AND (plugin_annotations -> $2 -> 'queue' ->> 'dueAt')::timestamptz <= $3))
      ORDER BY (plugin_annotations -> $2 -> 'queue' ->> 'dueAt')::timestamptz NULLS FIRST, id
      LIMIT $4`,
    [accountId, pluginId, now, limit],
  );
  return rows;
}

// countQueued({ accountId, pluginId, origin }) → { pending, retry, done, terminal } over the rows
// marked with that origin.
export async function countQueued(args) {
  const { accountId, pluginId } = parseCommon(args);
  const origin = parseOrigin(args.origin);
  const { rows } = await query(
    `SELECT plugin_annotations -> $2 -> 'queue' ->> 'state' AS state, COUNT(*)::int AS count
       FROM messages
      WHERE account_id = $1 AND plugin_annotations -> $2 -> 'queue' ->> 'origin' = $3
      GROUP BY 1`,
    [accountId, pluginId, origin],
  );
  const counts = Object.fromEntries(QUEUE_STATES.map(state => [state, 0]));
  for (const { state, count } of rows) {
    if (!QUEUE_STATES.includes(state)) throw new Error(`plugin ${pluginId} has a queue state ${JSON.stringify(state)} outside ${QUEUE_STATES.join('|')}`);
    counts[state] = count;
  }
  return counts;
}

// listMessagesInQueueState({ accountId, pluginId, state, afterId, limit }) → rows whose queue is in
// `state`, by id, starting after `afterId` (null for the first page); at most 200. Rows have the
// shape listQueuedMessages returns. A plugin pages through, say, its terminal rows with the last
// id of each page.
export async function listMessagesInQueueState(args) {
  const { accountId, pluginId } = parseCommon(args);
  if (!QUEUE_STATES.includes(args.state)) throw new TypeError(`state must be one of ${QUEUE_STATES.join(', ')}`);
  const afterId = args.afterId ?? null;
  if (afterId !== null && (typeof afterId !== 'string' || !afterId)) throw new TypeError('afterId must be a message row id or null');
  const limit = parseLimit(args.limit, MAX_LIST_LIMIT);
  const { rows } = await query(
    `SELECT id, folder, uid, message_id, date, synced_at, plugin_annotations -> $2 AS plugin_annotation
       FROM messages
      WHERE account_id = $1
        AND plugin_annotations -> $2 -> 'queue' ->> 'state' = $3
        AND ($4::uuid IS NULL OR id > $4::uuid)
      ORDER BY id
      LIMIT $5`,
    [accountId, pluginId, args.state, afterId, limit],
  );
  return rows;
}
