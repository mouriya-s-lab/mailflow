import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
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

import { ImapFlow } from 'imapflow';
import { query } from '../../src/services/db.js';
import { logger } from '../../src/services/logger.js';
import { resolveForConnection } from '../../src/services/hostValidation.js';
import { getConnectionPolicy } from '../../src/services/connectionPolicy.js';
import { ImapManager, evictPool } from '../../src/services/imapManager.js';
import { moveMessagesVerified } from './index.js';

const require = createRequire(import.meta.url);
const compileSearch = require('imapflow/lib/commands/search.js');
const compileCommand = require('imapflow/lib/handler/imap-compiler.js');

async function searchWire(call) {
  let text;
  await compileSearch({
    state: 'SELECTED', states: { SELECTED: 'SELECTED' },
    capabilities: new Set(), enabled: new Set(), mailbox: {}, log: { warn: vi.fn() },
    exec: async (command, attributes) => {
      text = (await compileCommand({ tag: 'A1', command, attributes })).toString();
      return { next() {} };
    },
  }, call.args[0], call.args[1]);
  return text;
}

// Includes RFC 3501's reversed n:* range: if n exceeds the highest UID, that highest
// UID is still selected. The implementation must discard this old hit, not move its row.
function inRange(uid, range, highest) {
  return [].concat(range).join(',').split(',').some(part => {
    const bounds = part.split(':').map(value => value === '*' ? highest : Number(value));
    return bounds.length === 1 ? uid === bounds[0]
      : uid >= Math.min(...bounds) && uid <= Math.max(...bounds);
  });
}

function fakeSession(server, calls, options) {
  const client = new EventEmitter();
  client.capabilities = new Set(options.capabilities ?? []);
  client.enabled = new Set();
  const record = (name, args) => calls.push({ name, folder: client.mailbox?.path, args });
  const selected = () => server.get(client.mailbox.path);
  const matching = (range) => {
    const messages = selected().messages;
    const highest = Math.max(0, ...messages.keys());
    return [...messages].filter(([uid]) => inRange(uid, range, highest));
  };
  client.connect = vi.fn(async () => {});
  client.close = vi.fn();
  client.logout = vi.fn(async () => {});
  client.noop = vi.fn(async () => true);
  client.getMailboxLock = vi.fn(async (path) => {
    record('lock', [path]);
    const folder = server.get(path);
    client.mailbox = { path, uidValidity: folder.uidValidity, uidNext: folder.uidNext };
    return { release: () => record('release', [path]) };
  });
  client.fetch = vi.fn(async function* (...args) {
    record('fetch', args);
    for (const [uid, message] of matching(args[0])) yield { uid, envelope: { messageId: message.messageId } };
  });
  client.status = vi.fn(async (...args) => {
    record('status', args);
    if (options.statusError) throw options.statusError;
    return { uidNext: server.get(args[0]).uidNext };
  });
  const transfer = (name, args) => {
    record(name, args);
    const target = server.get(args[1]);
    const uidMap = new Map();
    for (const [uid, message] of matching(args[0])) {
      const newUid = target.uidNext++;
      if (!options.targetViewStale) {
        target.messages.set(newUid, { ...message, deleted: false });
        if (options.duplicateCopy) target.messages.set(target.uidNext++, { ...message, deleted: false });
      }
      uidMap.set(uid, options.reportedUid ?? newUid);
      if (name === 'move') selected().messages.delete(uid);
    }
    return { uidMap };
  };
  client.messageMove = vi.fn(async (...args) => transfer('move', args));
  client.messageCopy = vi.fn(async (...args) => transfer('copy', args));
  client.messageFlagsAdd = vi.fn(async (...args) => {
    record('flagsAdd', args);
    for (const [, message] of matching(args[0])) if (args[1].includes('\\Deleted')) message.deleted = true;
    return true;
  });
  client.messageFlagsRemove = vi.fn(async (...args) => {
    record('flagsRemove', args);
    for (const [, message] of matching(args[0])) if (args[1].includes('\\Deleted')) message.deleted = false;
    return true;
  });
  client.messageDelete = vi.fn(async (...args) => {
    record('expunge', args);
    const candidates = client.capabilities.has('UIDPLUS') ? matching(args[0]) : [...selected().messages];
    for (const [uid, message] of candidates) if (message.deleted) selected().messages.delete(uid);
    return true;
  });
  client.search = vi.fn(async (...args) => {
    record('search', args);
    const [criteria] = args;
    const messages = criteria.uid ? matching(criteria.uid) : [...selected().messages];
    return messages.filter(([, message]) => {
      if (criteria.deleted && !message.deleted) return false;
      return !criteria.header || message.messageId === criteria.header['Message-ID'];
    }).map(([uid]) => uid);
  });
  return client;
}

// Only connection-local TEMP tables: no persistent schema or test data is changed.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('verified move with PostgreSQL and the real pooled IMAP primitive', () => {
  const accountId = '13000000-0000-4000-8000-000000000001';
  const annotations = { gtd: { task: 'keep this task' } };
  const headers = { 'list-id': ['list.example.test'] };
  let database, engine, server, calls, warn, nextId;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id text, imap_host text,
        imap_port integer, imap_tls boolean, auth_user text, auth_pass text);
      CREATE TEMP TABLE folders (account_id uuid, path text, uid_validity bigint,
        total_count integer DEFAULT 0, unread_count integer DEFAULT 0, UNIQUE(account_id,path));
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text,
        uid bigint, message_id text, is_read boolean DEFAULT false, is_deleted boolean DEFAULT false,
        plugin_annotations jsonb NOT NULL DEFAULT '{}', UNIQUE(account_id,uid,folder));
      CREATE TEMP TABLE fork_message_headers (message_id uuid PRIMARY KEY REFERENCES messages(id)
        ON DELETE CASCADE, headers jsonb)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => {
    vi.useRealTimers();
    await database.query('TRUNCATE fork_message_headers, messages, folders, email_accounts');
    await database.query("INSERT INTO email_accounts VALUES ($1,'owner','127.0.0.1',993,true,'u','enc')", [accountId]);
    await database.query("INSERT INTO folders(account_id,path,uid_validity) VALUES ($1,'INBOX',7),($1,'Archive',9)", [accountId]);
    nextId = 1;
    server = new Map([
      ['INBOX', { uidValidity: 7n, uidNext: 100, messages: new Map() }],
      ['Archive', { uidValidity: 9n, uidNext: 50, messages: new Map() }],
    ]);
    calls = [];
    ImapFlow.mockReset();
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: false });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    engine = Object.create(ImapManager.prototype);
    engine._pendingMoveUids = new Map();
    engine.broadcast = vi.fn();
    engine.syncFolderOnDemand = vi.fn(async () => {});
    session();
  });
  afterEach(async () => {
    // A queued SELECT also drains fire-and-forget count writes before the next TRUNCATE.
    await database.query('SELECT 1');
    evictPool(accountId);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function session(options = {}) {
    ImapFlow.mockImplementation(function () { return fakeSession(server, calls, options); });
  }
  async function row({ uid = 11, folder = 'INBOX', messageId = '<task@example.test>', serverId = messageId,
    present = true, isRead = false, isDeleted = false } = {}) {
    const id = `13000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;
    await database.query(`INSERT INTO messages(id,account_id,folder,uid,message_id,is_read,is_deleted,plugin_annotations)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, accountId, folder, uid, messageId, isRead, isDeleted, annotations]);
    await database.query('INSERT INTO fork_message_headers VALUES ($1,$2)', [id, headers]);
    if (!isDeleted) await database.query(`UPDATE folders SET total_count=total_count+1,
      unread_count=unread_count+$3 WHERE account_id=$1 AND path=$2`, [accountId, folder, isRead ? 0 : 1]);
    if (present) server.get(folder).messages.set(uid, { messageId: serverId, deleted: isDeleted });
    return id;
  }
  const move = (ids) => moveMessagesVerified(engine, { accountId, messageIds: ids, toFolder: 'Archive' });
  const rows = async () => (await database.query('SELECT * FROM messages ORDER BY id')).rows;
  const retained = async (id) => (await database.query(`SELECT m.id,m.folder,m.uid,m.plugin_annotations,h.headers
    FROM messages m JOIN fork_message_headers h ON h.message_id=m.id WHERE m.id=$1`, [id])).rows[0];
  const writes = () => calls.filter(call => ['move', 'copy', 'flagsAdd', 'flagsRemove', 'expunge'].includes(call.name));
  const counts = async () => (await database.query('SELECT path,total_count,unread_count FROM folders ORDER BY path')).rows;

  it('row 5: ignores an undeclared COPYUID map and locates the moved identity with UIDNEXT-bounded SEARCH', async () => {
    session({ reportedUid: 999 });
    const id = await row();
    await row({ uid: 12, messageId: '<stay@example.test>' });
    await row({ uid: 8, folder: 'Archive' });
    const result = await move([id]);
    expect(result.get(id)).toEqual({ kind: 'moved', uid: 50 });
    expect(calls.map(call => call.name)).toEqual([
      'lock', 'fetch', 'status', 'copy', 'search', 'search', 'flagsAdd', 'expunge',
      'release', 'lock', 'search', 'release',
    ]);
    expect(calls[0].args).toEqual(['INBOX']);
    expect(calls[1].args).toEqual([[11], { uid: true, envelope: true }, { uid: true }]);
    expect(calls[2].args).toEqual(['Archive', { uidNext: true }]);
    expect(calls[3].args).toEqual([['11'], 'Archive', { uid: true }]);
    expect(calls[4].args).toEqual([{ uid: '11' }, { uid: true }]);
    expect(calls[5].args).toEqual([{ deleted: true }, { uid: true }]);
    expect(calls[6].args).toEqual(['11', ['\\Deleted'], { uid: true }]);
    expect(calls[7].args).toEqual(['11', { uid: true }]);
    expect(calls[9].args).toEqual(['Archive']);
    expect(calls[10].args).toEqual([{ uid: '50:*', header: { 'Message-ID': '<task@example.test>' } }, { uid: true }]);
    expect(await searchWire(calls[10])).toBe('A1 UID SEARCH UID 50:* HEADER MESSAGE-ID <task@example.test>');
    expect(await retained(id)).toEqual({ id, folder: 'Archive', uid: '50', plugin_annotations: annotations, headers });
    expect([...server.get('INBOX').messages.keys()]).toEqual([12]);
    expect([...server.get('Archive').messages.keys()]).toEqual([8, 50]);
    expect(engine._pendingMoveUids.size).toBe(0);
  });

  it('UIDPLUS+MOVE preserves the original row, replaces a competing target row, and accounts for its counts', async () => {
    session({ capabilities: ['UIDPLUS', 'MOVE'] });
    const id = await row();
    const displaced = await row({ uid: 50, folder: 'Archive', messageId: '<competing@example.test>' });
    // This database row models a sync racing the move; the server is about to allocate UID 50.
    server.get('Archive').messages.delete(50);
    const result = await move([id]);
    expect(result.get(id)).toEqual({ kind: 'moved', uid: 50 });
    expect(calls.map(call => call.name)).toEqual(['lock', 'fetch', 'move', 'release']);
    expect(calls[2].args).toEqual([['11'], 'Archive', { uid: true }]);
    expect(await retained(id)).toEqual({ id, folder: 'Archive', uid: '50', plugin_annotations: annotations, headers });
    expect((await rows()).map(item => item.id)).toEqual([id]);
    expect(await retained(displaced)).toBeUndefined();
    await vi.waitFor(async () => expect(await counts()).toEqual([
      { path: 'Archive', total_count: 1, unread_count: 1 },
      { path: 'INBOX', total_count: 0, unread_count: 0 },
    ]));
    expect(engine.broadcast.mock.calls).toEqual([
      [{ type: 'folder_updated', folder: 'INBOX', accountId }, 'owner'],
      [{ type: 'folder_updated', folder: 'Archive', accountId }, 'owner'],
    ]);
    expect(engine._pendingMoveUids.size).toBe(0);
  });

  it.each([
    ['Message-ID mismatch', { serverId: '<different@example.test>' }, 'source_changed'],
    ['UID absent on server', { present: false }, 'source_changed'],
    ['NULL Message-ID', { messageId: null }, 'no_message_id'],
    ['unknown folder UIDVALIDITY', {}, 'uidvalidity_unknown'],
    ['changed session UIDVALIDITY', {}, 'uidvalidity_changed'],
  ])('row 6: refuses %s without changing rows or issuing destructive commands', async (scenario, options, kind) => {
    const id = await row(options);
    if (scenario === 'unknown folder UIDVALIDITY') await database.query("UPDATE folders SET uid_validity=NULL WHERE path='INBOX'");
    if (scenario === 'changed session UIDVALIDITY') server.get('INBOX').uidValidity = 8n;
    const before = await rows();
    const beforeCounts = await counts();
    expect((await move([id])).get(id)).toEqual({ kind });
    expect(writes()).toEqual([]);
    expect(await rows()).toEqual(before);
    expect(await counts()).toEqual(beforeCounts);
    expect(await retained(id)).toMatchObject({ plugin_annotations: annotations, headers });
    expect(engine._pendingMoveUids.size).toBe(0);
  });

  it('row 7: reports a missing target folder without constructing an IMAP session', async () => {
    const id = await row();
    await database.query("DELETE FROM folders WHERE path='Archive'");
    const before = await rows();
    expect((await move([id])).get(id)).toEqual({ kind: 'folder_missing' });
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(await rows()).toEqual(before);
  });

  it('row 7: reports already_there without opening IMAP or changing the row', async () => {
    const id = await row({ folder: 'Archive' });
    const before = await rows();
    expect((await move([id])).get(id)).toEqual({ kind: 'already_there' });
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(await rows()).toEqual(before);
  });

  it('row 7: ambiguous target hits move the row unlocated, warn once, sync, and release its guard after ten seconds', async () => {
    session({ duplicateCopy: true });
    const id = await row();
    // Fake only timeout APIs; PostgreSQL sockets and promise scheduling stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect((await move([id])).get(id)).toEqual({ kind: 'moved_unlocated' });
    expect(await retained(id)).toEqual({ id, folder: 'Archive', uid: '11', plugin_annotations: annotations, headers });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('its UID in the target could not be determined');
    expect(engine.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: accountId }), 'Archive');
    expect([...engine._pendingMoveUids.entries()]).toEqual([[`${accountId}:Archive:11`, 1]]);
    await vi.advanceTimersByTimeAsync(9999);
    expect(engine._isMoveUidGuarded(accountId, 'Archive', 11)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine._pendingMoveUids.size).toBe(0);
  });

  it('row 5: does not mistake the old highest UID selected by n:* for a newly arrived message', async () => {
    session({ targetViewStale: true, reportedUid: 999 });
    const id = await row();
    await row({ uid: 8, folder: 'Archive' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect((await move([id])).get(id)).toEqual({ kind: 'moved_unlocated' });
    expect(await retained(id)).toMatchObject({ folder: 'Archive', uid: '11' });
    expect(calls.find(call => call.name === 'search' && call.folder === 'Archive').args[0].uid).toBe('50:*');
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('moved_unlocated collision leaves the source row and existing target row untouched', async () => {
    session({ duplicateCopy: true });
    const id = await row();
    const otherId = await row({ uid: 11, folder: 'Archive', messageId: '<other@example.test>' });
    const before = await rows();
    const beforeCounts = await counts();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect((await move([id])).get(id)).toEqual({ kind: 'moved_unlocated' });
    expect(await rows()).toEqual(before);
    expect(await counts()).toEqual(beforeCounts);
    expect(await retained(otherId)).toMatchObject({ folder: 'Archive', uid: '11', plugin_annotations: annotations, headers });
    expect(engine.syncFolderOnDemand).toHaveBeenCalledWith(expect.objectContaining({ id: accountId }), 'Archive');
    expect(engine.broadcast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine._pendingMoveUids.size).toBe(0);
  });

  it('preserves source_changed in a mixed group when STATUS fails after verification', async () => {
    session({ statusError: new Error('STATUS unavailable') });
    const changed = await row({ serverId: '<different@example.test>' });
    const matched = await row({ uid: 12, messageId: '<matched@example.test>' });
    const before = await rows();
    const result = await move([changed, matched]);
    expect(result).toEqual(new Map([
      [changed, { kind: 'source_changed' }],
      [matched, { kind: 'failed', reason: 'imap_error' }],
    ]));
    expect(calls.map(call => call.name)).toEqual(['lock', 'fetch', 'status', 'release']);
    expect(writes()).toEqual([]);
    expect(await rows()).toEqual(before);
    expect(engine._pendingMoveUids.size).toBe(0);
  });

  it('returns an outcome for every requested id, including absent and deleted rows', async () => {
    const deleted = await row({ isDeleted: true });
    const already = await row({ folder: 'Archive', uid: 12 });
    const missing = '13000000-0000-4000-8000-000000009999';
    const before = await rows();
    const requested = [missing, deleted, already];
    const result = await move(requested);
    expect([...result.keys()]).toEqual(requested);
    expect(result).toEqual(new Map([
      [missing, { kind: 'failed', reason: 'message_missing' }],
      [deleted, { kind: 'failed', reason: 'message_missing' }],
      [already, { kind: 'already_there' }],
    ]));
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(await rows()).toEqual(before);
  });
});
