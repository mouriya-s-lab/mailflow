// Header retention (K4, mouriya-s-lab/mailflow#10).
//
// A whitelisted set of each message's raw headers is kept in fork_message_headers, keyed by
// the messages row: written at ingest from the headers the sync/backfill FETCH already
// returned, or fetched from the server on demand for a row that has no record (mail ingested
// before this table existed, or a row that a move recreated under a new id). The record goes
// with its row through ON DELETE CASCADE.

import { query } from '../../src/services/db.js';
import { logger } from '../../src/services/logger.js';
import { parseHeadersInput } from '../../src/services/messageParser.js';
import { getMailEngine } from '../../src/plugins/mailEngine.js';

export const STORED_HEADER_NAMES = Object.freeze([
  'authentication-results',
  'arc-authentication-results',
  'received-spf',
  'content-language',
  'subject',
  'from',
  'sender',
  'reply-to',
  'return-path',
  'list-id',
]);

export const DEFAULT_DEADLINE_MS = 30000;

// The stored form of a parsed header block: the whitelisted headers only, with NUL removed
// (PostgreSQL cannot store it in jsonb). Returns null for a block with no header lines at all,
// which is no evidence about the message: the backfill's fallback FETCH for messages a server
// omitted asks for no headers, and a server can answer HEADER.FIELDS with an empty block.
// Storing {} for those would claim the message has none of these headers and stop any later
// read from fetching them.
export function storedHeaders(parsedHeaders) {
  if (!parsedHeaders || Object.keys(parsedHeaders).length === 0) return null;
  const headers = {};
  for (const name of STORED_HEADER_NAMES) {
    const value = parsedHeaders[name];
    if (typeof value === 'string') headers[name] = value.replaceAll('\u0000', '');
  }
  return headers;
}

// Ingest write, called by syncMessages and backfillMessages after every successful upsert of a
// message row. Never throws: a failure here must not cost the message its row or stop the
// batch, and a row left without a record is fetched on its next read.
export async function recordIngestHeaders(messageRowId, parsedHeaders) {
  const headers = storedHeaders(parsedHeaders);
  if (!headers) return;
  try {
    await query(
      `INSERT INTO fork_message_headers (message_id, headers, source)
       VALUES ($1, $2::jsonb, 'ingest')
       ON CONFLICT (message_id) DO NOTHING`,
      [messageRowId, JSON.stringify(headers)],
    );
  } catch (err) {
    logger.warn(`[headers] could not store the headers of message ${messageRowId}: ${err.message}`);
  }
}

const unavailable = reason => ({ kind: 'unavailable', reason });

// Fetches in progress, by message row id, so concurrent reads of the same message share one
// fetch. An entry is added synchronously after the read that found the record missing and is
// removed when that fetch settles.
const inflight = new Map();

// getMessageHeaders(messageIds, { deadlineMs }) → Map<id, HeaderResult>
//   { kind: 'stored', headers, source }
//   { kind: 'unavailable', reason: 'message_missing' | 'imap_error' | 'not_on_server' }
//
// Rows without a record are grouped by (account, folder); each group is one IMAP session and
// one UID FETCH of the whitelisted header fields, and the groups run one after another. The
// deadline (default and maximum DEFAULT_DEADLINE_MS) is checked before each group starts; a
// group not started by then is imap_error. Nothing is written for a message that could not be
// fetched. Database errors are thrown to the caller.
export async function getMessageHeaders(messageIds, { deadlineMs } = {}) {
  const deadline = Date.now() + Math.min(DEFAULT_DEADLINE_MS, deadlineMs ?? DEFAULT_DEADLINE_MS);
  const ids = [...new Set(messageIds)];
  const results = new Map();
  if (ids.length === 0) return results;

  const { rows } = await query(
    `SELECT m.id, m.account_id, m.folder, m.uid, h.headers, h.source
       FROM messages m
       LEFT JOIN fork_message_headers h ON h.message_id = m.id
      WHERE m.id = ANY($1::uuid[])`,
    [ids],
  );
  const rowById = new Map(rows.map(row => [row.id, row]));

  const waiting = [];
  const groups = new Map(); // `${account_id}\n${folder}` -> rows
  for (const id of ids) {
    const row = rowById.get(id);
    if (!row) results.set(id, unavailable('message_missing'));
    else if (row.source) results.set(id, { kind: 'stored', headers: row.headers, source: row.source });
    else if (inflight.has(id)) waiting.push([id, inflight.get(id)]);
    else {
      const key = `${row.account_id}\n${row.folder}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
  }

  if (groups.size) {
    const run = fetchGroups([...groups.values()], deadline);
    for (const groupRows of groups.values()) {
      for (const row of groupRows) {
        const settled = run.then(fetched => fetched.get(row.id));
        inflight.set(row.id, settled);
        const clear = () => { if (inflight.get(row.id) === settled) inflight.delete(row.id); };
        settled.then(clear, clear);
        waiting.push([row.id, settled]);
      }
    }
  }

  for (const [id, settled] of waiting) results.set(id, await settled);
  return results;
}

async function fetchGroups(groups, deadline) {
  const accountIds = [...new Set(groups.map(rows => rows[0].account_id))];
  const { rows: accounts } = await query('SELECT * FROM email_accounts WHERE id = ANY($1::uuid[])', [accountIds]);
  const accountById = new Map(accounts.map(account => [account.id, account]));

  const fetched = new Map();
  for (const rows of groups) {
    const account = accountById.get(rows[0].account_id);
    // The account was deleted after the rows were read; its messages went with it.
    if (!account) { for (const row of rows) fetched.set(row.id, unavailable('message_missing')); continue; }
    if (Date.now() >= deadline) {
      logger.warn(`[headers] deadline passed before fetching ${rows.length} message(s) of account ${account.id} folder ${rows[0].folder}`);
      for (const row of rows) fetched.set(row.id, unavailable('imap_error'));
      continue;
    }
    for (const [id, result] of await fetchGroup(account, rows[0].folder, rows)) fetched.set(id, result);
  }
  return fetched;
}

async function fetchGroup(account, folder, rows) {
  const results = new Map();
  const where = `account ${account.id} folder ${folder}`;

  let session;
  try {
    session = await getMailEngine().fetchHeaderFields(account, folder, rows.map(row => Number(row.uid)), STORED_HEADER_NAMES);
  } catch (err) {
    logger.warn(`[headers] header fetch failed for ${rows.length} message(s) of ${where}: ${err.message}`);
    for (const row of rows) results.set(row.id, unavailable('imap_error'));
    return results;
  }

  // A UIDVALIDITY other than the one these rows were stored under means the server renumbered
  // the folder: the rows are stale until the next sync purges them, and their UIDs may now
  // name other messages. Nothing is fetched for them.
  const { rows: [folderRow] } = await query(
    'SELECT uid_validity FROM folders WHERE account_id = $1 AND path = $2',
    [account.id, folder],
  );
  const storedValidity = folderRow?.uid_validity == null ? null : String(folderRow.uid_validity);
  if (storedValidity !== null && session.uidValidity !== null && storedValidity !== session.uidValidity) {
    logger.warn(`[headers] ${where} UIDVALIDITY is ${session.uidValidity} on the server but ${storedValidity} locally; ${rows.length} message(s) not fetched`);
    for (const row of rows) results.set(row.id, unavailable('not_on_server'));
    return results;
  }

  const records = [];
  let notOnServer = 0;
  let empty = 0;
  for (const row of rows) {
    const raw = session.headers.get(Number(row.uid));
    if (raw === undefined) { notOnServer++; results.set(row.id, unavailable('not_on_server')); continue; }
    const headers = storedHeaders(parseHeadersInput(raw));
    if (!headers) { empty++; results.set(row.id, unavailable('imap_error')); continue; }
    records.push({ message_id: row.id, headers });
  }
  if (notOnServer) logger.warn(`[headers] ${notOnServer} of ${rows.length} message(s) of ${where} are not on the server`);
  if (empty) logger.warn(`[headers] the server returned no header fields for ${empty} of ${rows.length} message(s) of ${where}`);
  if (!records.length) return results;

  // The JOIN skips rows deleted since they were read. A record that already exists (an ingest
  // of the same row raced this fetch) is kept, and what is stored is read back and returned.
  await query(
    `INSERT INTO fork_message_headers (message_id, headers, source)
     SELECT r.message_id, r.headers, 'imap_fetch'
       FROM jsonb_to_recordset($1::jsonb) AS r(message_id uuid, headers jsonb)
       JOIN messages m ON m.id = r.message_id
     ON CONFLICT (message_id) DO NOTHING`,
    [JSON.stringify(records)],
  );
  const { rows: stored } = await query(
    'SELECT message_id, headers, source FROM fork_message_headers WHERE message_id = ANY($1::uuid[])',
    [records.map(record => record.message_id)],
  );
  const storedById = new Map(stored.map(row => [row.message_id, row]));
  for (const { message_id: id } of records) {
    const row = storedById.get(id);
    results.set(id, row ? { kind: 'stored', headers: row.headers, source: row.source } : unavailable('message_missing'));
  }
  return results;
}
