// Verified move (K7, mouriya-s-lab/mailflow#13).
//
// Moves a plugin's messages to another folder only once the server, in the session that moves
// them, has confirmed each row still names the message it was stored for (UIDVALIDITY, UID,
// RFC Message-ID; see ImapManager.moveVerifiedUids). The local row follows the server: it is
// updated in place only after the server confirmed the move, so it keeps its id, its plugin
// annotations and its retained headers. A message without a Message-ID is never moved.
//
// MoveOutcome:
//   { kind: 'moved', uid }       on the server in the target at `uid`; the row is there too
//   { kind: 'moved_unlocated' }  moved on the server, target UID unknown; the row's folder is the
//                                target (unless another row already holds its UID there, when it
//                                stays in the source) and the next syncs replace it, which may
//                                cost the message its row id and annotations
//   { kind: 'already_there' }    the row is already in the target folder
//   { kind: 'no_message_id' }    the row has no Message-ID, so its identity cannot be checked
//   { kind: 'folder_missing' }   the target folder is not one of the account's folders
//   { kind: 'source_changed' }   the UID is not on the server, or holds another Message-ID
//   { kind: 'uidvalidity_unknown' }  the source folder's UIDVALIDITY was never recorded
//   { kind: 'uidvalidity_changed' }  the server renumbered the source folder
//   { kind: 'failed', reason }   'message_missing' (no such row, or it is flagged \Deleted),
//                                'imap_error' or 'move_not_confirmed'
// Only moved, moved_unlocated and already_there leave the message in the target. source_changed,
// uidvalidity_* and failed can be retried once sync has rebuilt the local rows. When the server
// confirmed a move but the row could not follow it, the outcome still says moved (a warning is
// logged): reporting a move that happened as failed would invite moving it again.

import { query } from '../../src/services/db.js';
import { logger } from '../../src/services/logger.js';
import { adjustFolderCounts } from '../../src/utils/mailUtils.js';

// How long a row whose target UID is unknown stays protected from reconcileDeletes while it holds
// its source UID in the target folder, as in spamPipeline.autoMove.
const UNLOCATED_GUARD_MS = 10_000;

const bare = value => String(value ?? '').replace(/[<>]/g, '').trim();

function parseArgs(args) {
  const { accountId, messageIds, toFolder } = args ?? {};
  if (typeof accountId !== 'string' || !accountId) throw new TypeError('accountId must be a non-empty string');
  if (!Array.isArray(messageIds) || messageIds.some(id => typeof id !== 'string' || !id)) {
    throw new TypeError('messageIds must be an array of message row ids');
  }
  if (typeof toFolder !== 'string' || !toFolder) throw new TypeError('toFolder must be a non-empty string');
  return { accountId, messageIds: [...new Set(messageIds)], toFolder };
}

// moveMessagesVerified(engine, { accountId, messageIds, toFolder }) → Map<id, MoveOutcome>
// Source folders are handled one after another, each in one IMAP session. Database errors before
// any move are thrown to the caller.
export async function moveMessagesVerified(engine, args) {
  const { accountId, messageIds, toFolder } = parseArgs(args);
  const outcomes = new Map();
  if (!messageIds.length) return outcomes;

  const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  if (!account) throw new Error(`account ${accountId} not found`);
  const { rows } = await query(
    `SELECT id, folder, uid, message_id, is_read FROM messages
      WHERE account_id = $1 AND id = ANY($2::uuid[]) AND is_deleted = false`,
    [accountId, messageIds],
  );
  const rowById = new Map(rows.map(row => [row.id, row]));
  const { rows: folders } = await query(
    'SELECT path, uid_validity FROM folders WHERE account_id = $1 AND path = ANY($2::text[])',
    [accountId, [...new Set([toFolder, ...rows.map(row => row.folder)])]],
  );
  const uidValidityOf = new Map(folders.map(folder => [folder.path, folder.uid_validity]));

  const groups = new Map(); // source folder -> rows
  for (const id of messageIds) {
    const row = rowById.get(id);
    if (!row) outcomes.set(id, { kind: 'failed', reason: 'message_missing' });
    else if (row.folder === toFolder) outcomes.set(id, { kind: 'already_there' });
    else if (!bare(row.message_id)) outcomes.set(id, { kind: 'no_message_id' });
    else if (!uidValidityOf.has(toFolder)) outcomes.set(id, { kind: 'folder_missing' });
    else if (uidValidityOf.get(row.folder) == null) outcomes.set(id, { kind: 'uidvalidity_unknown' });
    else {
      if (!groups.has(row.folder)) groups.set(row.folder, []);
      groups.get(row.folder).push(row);
    }
  }

  const touched = new Set();
  for (const [fromFolder, groupRows] of groups) {
    const moved = await moveGroup(engine, account, fromFolder, String(uidValidityOf.get(fromFolder)), groupRows, toFolder, outcomes);
    if (moved) touched.add(fromFolder).add(toFolder);
  }
  for (const folder of touched) engine.broadcast({ type: 'folder_updated', folder, accountId }, account.user_id);
  return outcomes;
}

// Moves one source folder's rows and records their outcomes. Returns whether any row moved
// locally. The source UIDs stay guarded from reconcileDeletes until their rows are updated.
async function moveGroup(engine, account, fromFolder, uidValidity, rows, toFolder, outcomes) {
  const where = `account ${account.id} ${fromFolder} → ${toFolder}`;
  for (const row of rows) engine._guardMoveUid(account.id, fromFolder, row.uid);
  try {
    let server;
    try {
      server = await engine.moveVerifiedUids(account, {
        fromFolder, uidValidity, toFolder,
        items: rows.map(row => ({ uid: Number(row.uid), messageId: row.message_id })),
      });
    } catch (err) {
      logger.warn(`[verified-move] ${where}: IMAP failed before the messages were checked (${err.message}); ${rows.length} message(s) not moved`);
      for (const row of rows) outcomes.set(row.id, { kind: 'failed', reason: 'imap_error' });
      return false;
    }

    switch (server.kind) {
      case 'uidvalidity_changed':
        logger.warn(`[verified-move] ${where}: UIDVALIDITY is ${server.serverUidValidity} on the server but ${uidValidity} locally; ${rows.length} message(s) not moved`);
        for (const row of rows) outcomes.set(row.id, { kind: 'uidvalidity_changed' });
        return false;
      case 'checked':
        break;
      default:
        throw new Error(`unhandled verified move result ${server.kind}`);
    }

    let total = 0;
    let unread = 0;
    let unlocated = false;
    for (const row of rows) {
      const result = server.results.get(Number(row.uid));
      switch (result?.kind) {
        case 'source_changed':
        case 'failed':
          outcomes.set(row.id, result);
          break;
        case 'moved':
          if (await relocate(account, row, toFolder, result.uid, where)) { total++; if (!row.is_read) unread++; }
          outcomes.set(row.id, { kind: 'moved', uid: result.uid });
          break;
        case 'moved_unlocated':
          logger.warn(`[verified-move] ${where}: message ${row.id} (UID ${row.uid}) moved on the server, but its UID in the target could not be determined; the next sync of ${toFolder} replaces its row`);
          if (await relocateUnlocated(engine, account, row, toFolder, where)) { total++; if (!row.is_read) unread++; }
          unlocated = true;
          outcomes.set(row.id, { kind: 'moved_unlocated' });
          break;
        default:
          throw new Error(`no verified move result for UID ${row.uid} of ${where}`);
      }
    }
    if (unlocated) {
      engine.syncFolderOnDemand(account, toFolder)
        .catch(err => logger.warn(`[verified-move] ${where}: target sync failed (${err.message})`));
    }
    adjustFolderCounts(account.id, fromFolder, -total, -unread);
    adjustFolderCounts(account.id, toFolder, total, unread);
    return total > 0;
  } finally {
    for (const row of rows) engine._unguardMoveUid(account.id, fromFolder, row.uid);
  }
}

// The server holds the message at (toFolder, newUid): a row a sync already made for it there
// gives way, and this row takes the place, keeping its id.
async function relocate(account, row, toFolder, newUid, where) {
  try {
    const { rows: displaced } = await query(
      'DELETE FROM messages WHERE account_id = $1 AND folder = $2 AND uid = $3 AND id <> $4 RETURNING is_read',
      [account.id, toFolder, newUid, row.id],
    );
    if (displaced.length) adjustFolderCounts(account.id, toFolder, -displaced.length, -displaced.filter(d => !d.is_read).length);
    const { rowCount } = await query('UPDATE messages SET folder = $2, uid = $3 WHERE id = $1', [row.id, toFolder, newUid]);
    return rowCount === 1;
  } catch (err) {
    logger.warn(`[verified-move] ${where}: message ${row.id} moved on the server to UID ${newUid}, but its row could not follow (${err.message}); the next sync of both folders reconciles it`);
    return false;
  }
}

// The target UID is unknown, so the row moves to the target folder still holding its source UID,
// guarded so reconcileDeletes leaves it alone until the target sync has found the message. A row
// already holding that UID in the target keeps it, and this row is left for the source sync.
async function relocateUnlocated(engine, account, row, toFolder, where) {
  engine._guardMoveUid(account.id, toFolder, row.uid);
  setTimeout(() => engine._unguardMoveUid(account.id, toFolder, row.uid), UNLOCATED_GUARD_MS);
  try {
    const { rowCount } = await query(
      `UPDATE messages SET folder = $2 WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.account_id = $3 AND o.folder = $2 AND o.uid = $4)`,
      [row.id, toFolder, account.id, row.uid],
    );
    return rowCount === 1;
  } catch (err) {
    logger.warn(`[verified-move] ${where}: message ${row.id} moved on the server, but its row could not follow (${err.message})`);
    return false;
  }
}
