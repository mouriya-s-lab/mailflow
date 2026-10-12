// Message bodies on demand (mouriya-s-lab/mailflow#38).
//
// Makes sure a batch of an account's messages has its body cached on the row before a plugin
// judges them. A row without body_html and body_text is fetched from the server with the engine's
// fetchMessageBody, by its own folder and UID (so each label copy of a Gmail message is its own
// fetch), and written back the way prefetchNewMessageBodies writes it. The write only fills a row
// whose body is still empty: a body another path stored meanwhile is never overwritten.
//
// BodyOutcome:
//   { kind: 'stored' }   the row already holds a body (or another writer stored one meanwhile)
//   { kind: 'fetched' }  fetched now and written to the row
//   { kind: 'empty' }    the server gave no renderable body; nothing was written. fetchMessageBody
//                        also answers this way when a UID FETCH stays empty after its retry, which
//                        can mean the message is no longer on the server
//   { kind: 'unavailable', reason }
//                        'provider_refusing'  the provider refused connections (or the login) in
//                                             this batch, or MailFlow is backing off from it
//                        'imap_error'         the fetch failed for another reason
//                        'message_missing'    no row of this account with that id, or the row was
//                                             gone when the body was written
//                        'deadline'           the deadline passed before this message was started
//
// Stop policy, as prefetchFolderBodies (the engine's _bodyFetchFailure applies it): a refusal stops
// the batch at once and arms the secondary backoff, PREFETCH_MAX_CONSECUTIVE_ERRORS failures in a
// row stop it too, and every message not fetched after a stop is unavailable for the same reason.
// The engine is passed in rather than imported: imapManager.js imports the application entry.

import { query } from '../../src/services/db.js';
import { logger } from '../../src/services/logger.js';
import { extractImapError } from '../../src/services/imapError.js';
import { sanitizeEmail } from '../../src/services/emailSanitizer.js';
import { snippetFromBody } from '../../src/services/messageParser.js';

const stripNul = value => (typeof value === 'string' ? value.replace(/\0/g, '') : value);

function parseArgs(accountId, messageIds, options) {
  if (typeof accountId !== 'string' || !accountId) throw new TypeError('accountId must be a non-empty string');
  if (!Array.isArray(messageIds) || messageIds.some(id => typeof id !== 'string' || !id)) {
    throw new TypeError('messageIds must be an array of message row ids');
  }
  const deadlineMs = options?.deadlineMs;
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) throw new TypeError('deadlineMs must be a non-negative number');
  return { accountId, messageIds: [...new Set(messageIds)], deadlineMs };
}

// Writes a fetched body to a row that still has none. Resolves to 'fetched', 'empty' (nothing to
// write), 'stored' (another writer filled the row first) or 'message_missing' (the row is gone).
async function writeBody(accountId, id, { html, text, attachments }) {
  const safeHtml = html ? sanitizeEmail(html) : null;
  if (!safeHtml && !text) return 'empty';
  const snippet = snippetFromBody(text, safeHtml || html);
  const { rowCount } = await query(
    `UPDATE messages
        SET body_html = $1, body_text = $2, attachments = $3,
            snippet = CASE WHEN $5 != '' THEN $5 ELSE snippet END
      WHERE id = $4 AND account_id = $6 AND body_html IS NULL AND body_text IS NULL`,
    [stripNul(safeHtml), stripNul(text) ?? null, JSON.stringify(attachments || []), id, stripNul(snippet) ?? '', accountId],
  );
  if (rowCount === 1) return 'fetched';
  const { rows: [row] } = await query(
    'SELECT (body_html IS NOT NULL OR body_text IS NOT NULL) AS has_body FROM messages WHERE id = $1 AND account_id = $2',
    [id, accountId],
  );
  // A row still without a body after the guarded write changed nothing has changed under the write;
  // nothing was stored, so it counts as missing and the next attempt reads it again.
  return row?.has_body ? 'stored' : 'message_missing';
}

// ensureMessageBodies(engine, accountId, messageIds, { deadlineMs }) → Map<id, BodyOutcome>
// Every requested id is in the Map. Messages are fetched one after another in the order given;
// deadlineMs counts from the call and is checked before each fetch. Database errors are thrown.
export async function ensureMessageBodies(engine, accountId, messageIds, options) {
  const args = parseArgs(accountId, messageIds, options);
  const deadline = Date.now() + args.deadlineMs;
  const outcomes = new Map();
  if (!args.messageIds.length) return outcomes;

  const { rows } = await query(
    `SELECT id, uid, folder, (body_html IS NOT NULL OR body_text IS NOT NULL) AS has_body
       FROM messages WHERE account_id = $1 AND id = ANY($2::uuid[])`,
    [args.accountId, args.messageIds],
  );
  const rowById = new Map(rows.map(row => [row.id, row]));
  const toFetch = [];
  for (const id of args.messageIds) {
    const row = rowById.get(id);
    if (!row) outcomes.set(id, { kind: 'unavailable', reason: 'message_missing' });
    else if (row.has_body) outcomes.set(id, { kind: 'stored' });
    else toFetch.push(row);
  }
  if (!toFetch.length) return outcomes;

  const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [args.accountId]);
  if (!account) throw new Error(`account ${args.accountId} not found`);

  let stopped = null; // after a stop, the reason every message left is unavailable
  let consecutiveErrors = 0;
  for (const row of toFetch) {
    if (stopped) { outcomes.set(row.id, { kind: 'unavailable', reason: stopped }); continue; }
    if (Date.now() >= deadline) { outcomes.set(row.id, { kind: 'unavailable', reason: 'deadline' }); continue; }
    let body;
    try {
      body = await engine.fetchMessageBody(account, row.uid, row.folder);
    } catch (err) {
      consecutiveErrors += 1;
      const failure = engine._bodyFetchFailure(account, err, consecutiveErrors);
      switch (failure.kind) {
        case 'refusing':
          outcomes.set(row.id, { kind: 'unavailable', reason: 'provider_refusing' });
          stopped = 'provider_refusing';
          logger.warn(`[message-bodies] account ${account.id}: the provider is refusing connections; body fetch stopped at message ${row.id}, ${toFetch.length - toFetch.indexOf(row) - 1} left unfetched`);
          break;
        case 'failed':
          outcomes.set(row.id, { kind: 'unavailable', reason: 'imap_error' });
          logger.warn(`[message-bodies] account ${account.id}: body fetch failed for message ${row.id} (${extractImapError(err)})`);
          if (failure.stop) {
            stopped = 'imap_error';
            logger.warn(`[message-bodies] account ${account.id}: body fetch stopped after ${consecutiveErrors} failures in a row`);
          }
          break;
        default:
          throw new Error(`unhandled body fetch failure ${JSON.stringify(failure.kind)}`, { cause: err });
      }
      continue;
    }
    consecutiveErrors = 0;
    const written = await writeBody(args.accountId, row.id, body);
    switch (written) {
      case 'fetched': outcomes.set(row.id, { kind: 'fetched' }); break;
      case 'stored': outcomes.set(row.id, { kind: 'stored' }); break;
      case 'empty': outcomes.set(row.id, { kind: 'empty' }); break;
      case 'message_missing': outcomes.set(row.id, { kind: 'unavailable', reason: 'message_missing' }); break;
      default: throw new Error(`unhandled body write result ${written}`);
    }
  }
  return outcomes;
}
