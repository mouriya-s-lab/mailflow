import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

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

import { ImapFlow } from 'imapflow';
import { query } from '../../src/services/db.js';
import { logger } from '../../src/services/logger.js';
import { resolveForConnection } from '../../src/services/hostValidation.js';
import { getConnectionPolicy } from '../../src/services/connectionPolicy.js';
import { parseRawHeaders } from '../../src/services/messageParser.js';
import { setMailEngine } from '../../src/plugins/mailEngine.js';
import { ImapManager, evictPool } from '../../src/services/imapManager.js';
import { STORED_HEADER_NAMES, storedHeaders, getMessageHeaders } from './index.js';

// imapflow's own command builder and wire compiler: a recorded client.fetch call is turned into
// the exact command text a real session would send.
const require = createRequire(import.meta.url);
const compileFetch = require('imapflow/lib/commands/fetch.js');
const compileCommand = require('imapflow/lib/handler/imap-compiler.js');
const { packMessageRange } = require('imapflow/lib/tools.js');

async function wireCommand([range, fetchQuery, options]) {
  let text = null;
  const connection = {
    state: 'SELECTED', states: { SELECTED: 'SELECTED' },
    capabilities: new Set(), enabled: new Set(), mailbox: {},
    exec: async (command, attributes) => {
      text = (await compileCommand({ tag: 'A1', command, attributes })).toString();
      return { next() {} };
    },
  };
  await compileFetch(connection, Array.isArray(range) ? packMessageRange(range) : range, fetchQuery, options);
  return text;
}

const RAW = (uid) => Buffer.from([
  'Authentication-Results: mx.example.test;',
  '\tspf=pass smtp.mailfrom=bank.example',
  `From: Bank <notice-${uid}@bank.example>`,
  'Received-SPF: pass (first)',
  'Received-SPF: pass (second)',
  'List-Id: <news\u0000.bank.example>',
  '',
  '',
].join('\r\n'));

let seq = 0;
let db;
let server;   // uid -> raw header block the fake server holds
let sessions; // every ImapFlow the pool constructed

function setup({ uids, folderValidity = '7', sessionValidity = 7n, connectError = null }) {
  const accountId = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const account = { id: accountId, user_id: 'u1', imap_host: '127.0.0.1', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };
  db.accounts.set(accountId, account);
  db.folderValidity.set(`${accountId}\nINBOX`, folderValidity);
  const ids = uids.map(uid => {
    const id = `10000000-0000-4000-8000-${String(seq * 1000 + uid).padStart(12, '0')}`;
    db.messages.set(id, { id, account_id: accountId, folder: 'INBOX', uid: String(uid) });
    return id;
  });
  server = new Map(uids.map(uid => [uid, RAW(uid)]));
  ImapFlow.mockImplementation(function () {
    const client = new EventEmitter();
    client.connect = vi.fn(() => (connectError ? Promise.reject(connectError) : Promise.resolve()));
    client.close = vi.fn();
    client.logout = vi.fn(async () => {});
    client.noop = vi.fn(async () => true);
    client.getMailboxLock = vi.fn(async () => { client.mailbox = { path: 'INBOX', uidValidity: sessionValidity }; return { release: vi.fn() }; });
    client.fetch = vi.fn(async function* (range) {
      for (const uid of range) if (server.has(uid)) yield { uid, headers: server.get(uid) };
    });
    sessions.push(client);
    return client;
  });
  return { account, ids };
}

function fakeQuery(sql, params) {
  if (sql.includes('LEFT JOIN fork_message_headers')) {
    return { rows: params[0].filter(id => db.messages.has(id)).map(id => ({ ...db.messages.get(id), ...(db.headers.get(id) || { headers: null, source: null }) })) };
  }
  if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: params[0].map(id => db.accounts.get(id)).filter(Boolean) };
  if (sql.startsWith('SELECT uid_validity FROM folders')) {
    const v = db.folderValidity.get(`${params[0]}\n${params[1]}`);
    return { rows: v === undefined ? [] : [{ uid_validity: v }] };
  }
  if (sql.includes('INSERT INTO fork_message_headers')) {
    db.inserts.push(params);
    for (const { message_id, headers } of JSON.parse(params[0])) {
      if (db.messages.has(message_id) && !db.headers.has(message_id)) {
        db.headers.set(message_id, { headers, source: 'imap_fetch', captured_at: `t${db.inserts.length}` });
      }
    }
    return { rows: [] };
  }
  if (sql.startsWith('SELECT message_id, headers, source FROM fork_message_headers')) {
    return { rows: params[0].filter(id => db.headers.has(id)).map(id => ({ message_id: id, ...db.headers.get(id) })) };
  }
  throw new Error(`unexpected SQL: ${sql}`);
}

let warn;
beforeEach(() => {
  db = { accounts: new Map(), messages: new Map(), headers: new Map(), folderValidity: new Map(), inserts: [] };
  sessions = [];
  query.mockReset().mockImplementation(async (sql, params) => fakeQuery(sql.trim(), params));
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: false });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  setMailEngine(Object.create(ImapManager.prototype));
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const account of db.accounts.values()) evictPool(account.id);
  vi.restoreAllMocks();
});

describe('storedHeaders', () => {
  it('keeps only the whitelisted headers as the parser gives them, without NUL', () => {
    const parsed = parseRawHeaders(Buffer.concat([RAW(1), Buffer.from('X-Unrelated: 1\r\n')]));
    expect(storedHeaders(parsed)).toEqual({
      'authentication-results': 'mx.example.test; spf=pass smtp.mailfrom=bank.example',
      from: 'Bank <notice-1@bank.example>',
      'received-spf': 'pass (first)\npass (second)',
      'list-id': '<news.bank.example>',
    });
  });

  it('stores a header block that has none of the whitelisted headers as an empty record', () => {
    expect(storedHeaders(parseRawHeaders('Date: Mon, 1 Jan 2026 00:00:00 +0000\r\n'))).toEqual({});
  });

  it('gives no record for a message without a header block', () => {
    expect(storedHeaders({})).toBeNull();
    expect(storedHeaders(parseRawHeaders(Buffer.from('\r\n')))).toBeNull();
  });
});

describe('getMessageHeaders', () => {
  it('reads 20 messages of one folder with one session and one UID FETCH of the whitelist, and joins concurrent reads of the same message', async () => {
    const uids = Array.from({ length: 20 }, (_, i) => 101 + i);
    const { ids } = setup({ uids });

    const [batch, ...same] = await Promise.all([
      getMessageHeaders(ids),
      ...Array.from({ length: 5 }, () => getMessageHeaders([ids[0]])),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].getMailboxLock).toHaveBeenCalledTimes(1);
    expect(sessions[0].fetch).toHaveBeenCalledTimes(1);
    const fields = STORED_HEADER_NAMES.join(' ');
    expect(await wireCommand(sessions[0].fetch.mock.calls[0]))
      .toBe(`A1 UID FETCH 101:120 (UID BODY.PEEK[HEADER.FIELDS (${fields})])`);

    for (const [i, id] of ids.entries()) {
      expect(batch.get(id)).toEqual({ kind: 'stored', source: 'imap_fetch', headers: storedHeaders(parseRawHeaders(RAW(uids[i]))) });
    }
    for (const result of same) expect(result.get(ids[0])).toEqual(batch.get(ids[0]));
    expect(db.inserts).toHaveLength(1);

    // A second read is answered from the table: no IMAP, the record is the one first written.
    const capturedAt = db.headers.get(ids[0]).captured_at;
    const again = await getMessageHeaders(ids);
    expect(sessions[0].fetch).toHaveBeenCalledTimes(1);
    expect(again.get(ids[0])).toEqual({ kind: 'stored', source: 'imap_fetch', headers: batch.get(ids[0]).headers });
    expect(db.headers.get(ids[0]).captured_at).toBe(capturedAt);
  });

  it('fetches a message once when five reads of it run at the same time', async () => {
    const { ids } = setup({ uids: [7] });
    const results = await Promise.all(Array.from({ length: 5 }, () => getMessageHeaders([ids[0]])));
    expect(sessions.flatMap(s => s.fetch.mock.calls)).toHaveLength(1);
    expect(new Set(results.map(r => r.get(ids[0]).kind))).toEqual(new Set(['stored']));
  });

  it('reports a message the server does not hold as not_on_server, writes nothing for it, and warns', async () => {
    const { ids } = setup({ uids: [1, 2] });
    server.delete(2);
    const results = await getMessageHeaders(ids);
    expect(results.get(ids[0]).kind).toBe('stored');
    expect(results.get(ids[1])).toEqual({ kind: 'unavailable', reason: 'not_on_server' });
    expect(db.headers.has(ids[1])).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('not on the server');
  });

  it('reports an unreachable server as imap_error, writes nothing, and warns', async () => {
    const { ids } = setup({ uids: [1, 2], connectError: new Error('connect ECONNREFUSED 127.0.0.1:993') });
    const results = await getMessageHeaders(ids);
    for (const id of ids) expect(results.get(id)).toEqual({ kind: 'unavailable', reason: 'imap_error' });
    expect(db.inserts).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('ECONNREFUSED');
  });

  it('writes nothing when the server answers with an empty header block', async () => {
    const { ids } = setup({ uids: [1] });
    server.set(1, Buffer.from('\r\n'));
    const results = await getMessageHeaders(ids);
    expect(results.get(ids[0])).toEqual({ kind: 'unavailable', reason: 'imap_error' });
    expect(db.inserts).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('fetches nothing for rows stored under another UIDVALIDITY', async () => {
    const { ids } = setup({ uids: [1], folderValidity: '7', sessionValidity: 8n });
    const results = await getMessageHeaders(ids);
    expect(results.get(ids[0])).toEqual({ kind: 'unavailable', reason: 'not_on_server' });
    expect(db.inserts).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not start a group after the deadline', async () => {
    const { ids } = setup({ uids: [1] });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(now + 10);
    const results = await getMessageHeaders(ids, { deadlineMs: 5 });
    expect(results.get(ids[0])).toEqual({ kind: 'unavailable', reason: 'imap_error' });
    expect(sessions).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports an id with no message row as message_missing without touching IMAP', async () => {
    setup({ uids: [1] });
    const results = await getMessageHeaders(['20000000-0000-4000-8000-000000000000']);
    expect(results.get('20000000-0000-4000-8000-000000000000')).toEqual({ kind: 'unavailable', reason: 'message_missing' });
    expect(sessions).toHaveLength(0);
  });
});
