import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../../src/services/db.js', () => ({ query: vi.fn() }));
vi.mock('../../src/routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('../../src/services/encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('../../src/services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../../src/services/pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../../src/utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.test') }));
vi.mock('../../src/services/hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('../../src/services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../../src/services/spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('../../src/services/mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { query } from '../../src/services/db.js';
import { logger } from '../../src/services/logger.js';
import { ImapManager, PREFETCH_MAX_CONSECUTIVE_ERRORS } from '../../src/services/imapManager.js';
import { ensureMessageBodies } from './index.js';

// The real engine with fetchMessageBody replaced, over an in-memory messages table whose UPDATE
// honours the same "still no body" condition the statement carries. The statements themselves run
// on PostgreSQL in the last block, when MAILFLOW_TEST_DATABASE_URL is set.
const ACCOUNT = { id: '00000000-0000-4000-8000-000000000001', user_id: 'u1', imap_host: 'imap.example.test' };
const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000002';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let rows;    // id -> { id, account_id, uid, folder, body_html, body_text, attachments, snippet }
let updates; // ids the guarded UPDATE was issued for
let mgr;

function message(n, overrides = {}) {
  const row = { id: id(n), account_id: ACCOUNT.id, uid: String(n), folder: 'INBOX', body_html: null, body_text: null, attachments: '[]', snippet: 'old', ...overrides };
  rows.set(row.id, row);
  return row.id;
}

const hasBody = row => row.body_html !== null || row.body_text !== null;

beforeEach(() => {
  rows = new Map();
  updates = [];
  mgr = new ImapManager({ clients: new Set() });
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  query.mockReset();
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM email_accounts')) return { rows: params[0] === ACCOUNT.id ? [ACCOUNT] : [] };
    if (sql.includes('id = ANY($2::uuid[])')) {
      const [accountId, ids] = params;
      return { rows: ids.map(i => rows.get(i)).filter(r => r && r.account_id === accountId).map(r => ({ id: r.id, uid: r.uid, folder: r.folder, has_body: hasBody(r) })) };
    }
    if (sql.startsWith('UPDATE messages')) {
      const [html, text, attachments, rowId, snippet, accountId] = params;
      updates.push(rowId);
      const row = rows.get(rowId);
      if (!row || row.account_id !== accountId || hasBody(row)) return { rowCount: 0 };
      Object.assign(row, { body_html: html, body_text: text, attachments, snippet: snippet !== '' ? snippet : row.snippet });
      return { rowCount: 1 };
    }
    if (sql.includes('AS has_body FROM messages WHERE id = $1')) {
      const row = rows.get(params[0]);
      return { rows: row && row.account_id === params[1] ? [{ has_body: hasBody(row) }] : [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const refusal = () => Object.assign(new Error('Command failed'), {
  responseText: 'AUTHENTICATE Server error - Please try again later', serverResponseCode: 'UNAVAILABLE',
});
const gateRefusal = () => Object.assign(new Error('Mail server is limiting connections for this account'), { providerRefusing: true });
const body = html => ({ html, text: null, attachments: [{ filename: 'a.pdf' }] });

describe('ensureMessageBodies (#38 row 4)', () => {
  it('leaves a stored body alone, fetches a missing one, stops at a refusal and fetches nothing after it', async () => {
    const stored = message(1, { body_text: 'already here' });
    const fetched = message(2);
    const refused = message(3);
    const after = message(4);
    const alsoStored = message(5, { body_html: '<p>kept</p>' });
    mgr.fetchMessageBody = vi.fn()
      .mockResolvedValueOnce(body('<p>Your statement is ready</p>'))
      .mockRejectedValueOnce(gateRefusal());

    const out = await ensureMessageBodies(mgr, ACCOUNT.id, [stored, fetched, refused, after, alsoStored], { deadlineMs: 60_000 });

    expect([...out]).toEqual([
      [stored, { kind: 'stored' }],
      [alsoStored, { kind: 'stored' }],
      [fetched, { kind: 'fetched' }],
      [refused, { kind: 'unavailable', reason: 'provider_refusing' }],
      [after, { kind: 'unavailable', reason: 'provider_refusing' }],
    ]);
    // Fetched by each row's own folder and UID; the stored rows and the one after the refusal never.
    expect(mgr.fetchMessageBody.mock.calls).toEqual([[ACCOUNT, '2', 'INBOX'], [ACCOUNT, '3', 'INBOX']]);
    expect(updates).toEqual([fetched]);
    expect(rows.get(stored).body_text).toBe('already here');
    expect(rows.get(alsoStored).body_html).toBe('<p>kept</p>');
    expect(rows.get(fetched)).toMatchObject({ body_html: '<p>Your statement is ready</p>', body_text: null, snippet: 'Your statement is ready', attachments: JSON.stringify([{ filename: 'a.pdf' }]) });
    expect(rows.get(after).body_html).toBeNull();
  });

  it('reports a message without a renderable body as empty and writes nothing', async () => {
    const none = message(6);
    mgr.fetchMessageBody = vi.fn().mockResolvedValue({ html: null, text: null, attachments: [] });
    const out = await ensureMessageBodies(mgr, ACCOUNT.id, [none], { deadlineMs: 60_000 });
    expect(out.get(none)).toEqual({ kind: 'empty' });
    expect(updates).toEqual([]);
  });

  it('never overwrites a body another path stored while the fetch ran', async () => {
    const raced = message(7);
    mgr.fetchMessageBody = vi.fn(async () => {
      rows.get(raced).body_html = '<p>opened by the user</p>';
      return body('<p>fetched copy</p>');
    });
    const out = await ensureMessageBodies(mgr, ACCOUNT.id, [raced], { deadlineMs: 60_000 });
    expect(out.get(raced)).toEqual({ kind: 'stored' });
    expect(rows.get(raced).body_html).toBe('<p>opened by the user</p>');
  });

  it('a row deleted while its body was fetched is message_missing; an id of another account is never fetched', async () => {
    const deleted = message(8);
    const foreign = message(9, { account_id: OTHER_ACCOUNT });
    mgr.fetchMessageBody = vi.fn(async () => { rows.delete(deleted); return body('<p>late</p>'); });
    const out = await ensureMessageBodies(mgr, ACCOUNT.id, [deleted, foreign], { deadlineMs: 60_000 });
    expect(out.get(deleted)).toEqual({ kind: 'unavailable', reason: 'message_missing' });
    expect(out.get(foreign)).toEqual({ kind: 'unavailable', reason: 'message_missing' });
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
  });

  it('a provider refusal stops the batch and arms the secondary backoff, never the live-sync cooldown', async () => {
    const ids = [message(10), message(11), message(12)];
    mgr.fetchMessageBody = vi.fn(async () => { throw refusal(); });
    const out = await ensureMessageBodies(mgr, ACCOUNT.id, ids, { deadlineMs: 60_000 });
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(ids.map(i => out.get(i))).toEqual(ids.map(() => ({ kind: 'unavailable', reason: 'provider_refusing' })));
    expect(mgr._secondaryCooldown.has(ACCOUNT.id)).toBe(true);
    expect(mgr._connectCooldown.has(ACCOUNT.id)).toBe(false);
  });

  it('a rejected login stops the batch like a refusal', async () => {
    const ids = [message(13), message(14)];
    mgr.fetchMessageBody = vi.fn(async () => { throw Object.assign(new Error('Command failed'), { responseText: 'AUTHENTICATE Invalid credentials', serverResponseCode: 'AUTHENTICATIONFAILED' }); });
    const out = await ensureMessageBodies(mgr, ACCOUNT.id, ids, { deadlineMs: 60_000 });
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(out.get(ids[1])).toEqual({ kind: 'unavailable', reason: 'provider_refusing' });
  });

  it('other failures are imap_error per message, and stop the batch only after three in a row', async () => {
    const ids = [message(15), message(16), message(17), message(18), message(19), message(20)];
    let n = 0;
    mgr.fetchMessageBody = vi.fn(async () => {
      n += 1;
      if (n === 2) return body('<p>ok</p>');
      throw new Error('message-level problem');
    });
    const out = await ensureMessageBodies(mgr, ACCOUNT.id, ids, { deadlineMs: 60_000 });
    // fail, ok, fail, fail, fail (third in a row: stop), not fetched
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(2 + PREFETCH_MAX_CONSECUTIVE_ERRORS);
    expect(ids.map(i => out.get(i).kind === 'unavailable' ? out.get(i).reason : out.get(i).kind))
      .toEqual(['imap_error', 'fetched', 'imap_error', 'imap_error', 'imap_error', 'imap_error']);
    expect(mgr._secondaryCooldown.has(ACCOUNT.id)).toBe(false);
  });

  it('starts no fetch once the deadline has passed', async () => {
    const ids = [message(21), message(22)];
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValueOnce(start); // the call: deadline = start + 1000
    clock.mockReturnValueOnce(start); // before the first fetch
    clock.mockReturnValue(start + 1000); // before the second fetch: the deadline is reached
    mgr.fetchMessageBody = vi.fn(async () => body('<p>first</p>'));
    const out = await ensureMessageBodies(mgr, ACCOUNT.id, ids, { deadlineMs: 1000 });
    expect(mgr.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(out.get(ids[0])).toEqual({ kind: 'fetched' });
    expect(out.get(ids[1])).toEqual({ kind: 'unavailable', reason: 'deadline' });
  });

  it('rejects a missing deadline', async () => {
    await expect(ensureMessageBodies(mgr, ACCOUNT.id, [id(1)], {})).rejects.toThrow(/deadlineMs/);
  });
});

// The statements on PostgreSQL, over connection-local TEMP tables: no persistent schema or data
// is changed.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('ensureMessageBodies on PostgreSQL', () => {
  let database;
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id text, imap_host text);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text, uid bigint,
        body_html text, body_text text, attachments jsonb DEFAULT '[]', snippet text)`);
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => {
    query.mockImplementation((sql, values) => database.query(sql, values));
    await database.query('TRUNCATE messages, email_accounts');
    await database.query("INSERT INTO email_accounts VALUES ($1, 'u1', 'imap.example.test')", [ACCOUNT.id]);
    await database.query(
      `INSERT INTO messages (id, account_id, folder, uid, body_html, body_text, snippet) VALUES
        ($1, $4, 'INBOX', 1, NULL, NULL, 'old'), ($2, $4, 'INBOX', 2, NULL, 'stored text', 'old'),
        ($3, $4, 'INBOX', 3, NULL, NULL, 'old')`,
      [id(1), id(2), id(3), ACCOUNT.id],
    );
  });

  it('fills an empty row, skips a stored one, and loses to a body written during the fetch', async () => {
    mgr.fetchMessageBody = vi.fn(async (account, uid) => {
      if (uid === '3') await database.query("UPDATE messages SET body_html = '<p>opened meanwhile</p>' WHERE id = $1", [id(3)]);
      return { html: `<p>fetched ${uid}</p>`, text: `fetched ${uid}`, attachments: [{ filename: 'a.pdf' }] };
    });

    const out = await ensureMessageBodies(mgr, ACCOUNT.id, [id(1), id(2), id(3)], { deadlineMs: 60_000 });

    expect([...out]).toEqual([[id(2), { kind: 'stored' }], [id(1), { kind: 'fetched' }], [id(3), { kind: 'stored' }]]);
    expect(mgr.fetchMessageBody.mock.calls.map(([, uid]) => uid)).toEqual(['1', '3']);
    const { rows: stored } = await database.query('SELECT id, body_html, body_text, attachments, snippet FROM messages ORDER BY uid');
    expect(stored).toEqual([
      { id: id(1), body_html: '<p>fetched 1</p>', body_text: 'fetched 1', attachments: [{ filename: 'a.pdf' }], snippet: 'fetched 1' },
      { id: id(2), body_html: null, body_text: 'stored text', attachments: [], snippet: 'old' },
      { id: id(3), body_html: '<p>opened meanwhile</p>', body_text: null, attachments: [], snippet: 'old' },
    ]);
  });
});
