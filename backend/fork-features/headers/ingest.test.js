import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

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
import { ImapManager } from '../../src/services/imapManager.js';

// Messages run through the real parser, so what is stored is what ingest actually parsed.
const message = uid => ({
  uid,
  flags: new Set(['\\Seen']),
  internalDate: new Date('2026-10-01T00:00:00Z'),
  envelope: { messageId: `<m${uid}@bank.example>`, subject: `Notice ${uid}`, from: [{ name: 'Bank', address: 'notice@bank.example' }], to: [], cc: [] },
  headers: Buffer.from([
    'Authentication-Results: mx.example.test; dkim=pass',
    'From: Bank <notice@bank.example>',
    `Subject: Notice ${uid}`,
    'Content-Language: zh-CN',
    'X-Unrelated: 1',
    '', '',
  ].join('\r\n')),
});
const STORED = uid => ({
  'authentication-results': 'mx.example.test; dkim=pass',
  'content-language': 'zh-CN',
  subject: `Notice ${uid}`,
  from: 'Bank <notice@bank.example>',
});

let rows, headerWrites, failHeaderWriteFor, serverUids, omitFromFirstFetch;
const account = { id: 'acct-hdr', user_id: 'u1', enabled: true, imap_host: 'imap.example.test', imap_tls: true, email_address: 'me@example.test' };

function client() {
  return Object.assign(new EventEmitter(), {
    mailbox: { exists: serverUids.length, uidValidity: 1 },
    connect: vi.fn().mockResolvedValue(), close: vi.fn(), logout: vi.fn().mockResolvedValue(),
    noop: vi.fn(async () => true),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    search: vi.fn(async () => serverUids),
    fetch: vi.fn(async function* (range, fetchQuery) {
      const uids = range.includes(':') ? serverUids : range.split(',').map(Number);
      for (const uid of uids) {
        if (fetchQuery.headers && omitFromFirstFetch.has(uid)) continue;
        const full = message(uid);
        // The backfill's fallback FETCH asks for uid, flags and envelope only.
        yield fetchQuery.headers ? full : { uid, flags: full.flags, envelope: full.envelope };
      }
    }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  rows = []; headerWrites = []; failHeaderWriteFor = new Set(); serverUids = [1, 2, 3]; omitFromFirstFetch = new Set();
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
  ImapFlow.mockImplementation(function () { return client(); });
  query.mockReset().mockImplementation(async (sql, params = []) => {
    if (sql.includes('INSERT INTO fork_message_headers')) {
      headerWrites.push({ sql, params });
      if (failHeaderWriteFor.has(params[0])) throw new Error('permission denied for table fork_message_headers');
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO messages')) {
      const existing = rows.find(r => r.folder === params[2] && r.uid === params[1]);
      if (existing) return { rows: [{ id: existing.id, is_new: false }] };
      const row = { id: `row-${params[1]}`, folder: params[2], uid: params[1] };
      rows.push(row);
      return { rows: [{ id: row.id, is_new: true }] };
    }
    if (sql.includes('SELECT * FROM email_accounts') || sql.includes('SELECT id FROM email_accounts')) return { rows: [account] };
    if (sql.includes('SELECT uid_validity')) return { rows: [{ uid_validity: 1 }] };
    if (sql.includes('COUNT(*) as count')) return { rows: [{ count: rows.length, max_uid: Math.max(0, ...rows.map(r => r.uid)) }] };
    if (sql.includes('COALESCE(MAX(uid), 0)')) return { rows: [{ max_uid: 0 }] };
    if (sql.trim().startsWith('SELECT') && sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
    if (sql.includes('SELECT uid FROM messages')) return { rows: rows.map(r => ({ uid: r.uid })) };
    return { rows: [] };
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

const manager = () => ({ backfillRunning: new Set(), broadcast: vi.fn(), pluginFacade: {}, _secondaryConnectBlocked: () => null,
  _noteSecondaryRefusal: vi.fn(), _applyFlagUpdates: ImapManager.prototype._applyFlagUpdates, maybeClassifyNewMessage: vi.fn() });

async function backfill() {
  const pending = ImapManager.prototype.backfillMessages.call(manager(), account, 'INBOX');
  await vi.runAllTimersAsync();
  await pending;
}
async function sync() {
  const pending = ImapManager.prototype.syncMessages.call(manager(), account, client(), 'INBOX', 50);
  await vi.runAllTimersAsync();
  await pending;
}
const stored = () => headerWrites.map(({ params }) => [params[0], JSON.parse(params[1])]);

describe('header capture at ingest', () => {
  it('backfill stores each message’s whitelisted headers once, as source ingest', async () => {
    serverUids = [1];
    await backfill();
    expect(headerWrites).toHaveLength(1);
    expect(headerWrites[0].sql).toMatch(/VALUES \(\$1, \$2::jsonb, 'ingest'\)\s+ON CONFLICT \(message_id\) DO NOTHING/);
    expect(stored()).toEqual([['row-1', STORED(1)]]);
  });

  it('live sync stores the headers on every upsert, including one that updates an existing row', async () => {
    serverUids = [1, 2];
    await sync();
    expect(stored()).toEqual([['row-1', STORED(1)], ['row-2', STORED(2)]]);
    await sync();
    expect(stored().map(([id]) => id)).toEqual(['row-1', 'row-2', 'row-1', 'row-2']);
  });

  it('a failed header write warns once and costs no message its row or the batch', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    failHeaderWriteFor.add('row-2');
    await backfill();
    expect(rows.map(r => r.uid)).toEqual([3, 2, 1]);
    expect(headerWrites.map(w => w.params[0])).toEqual(['row-3', 'row-2', 'row-1']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('row-2');
  });

  it('stores no record for a message the backfill fetched without headers', async () => {
    omitFromFirstFetch.add(2);
    await backfill();
    expect(rows.map(r => r.uid).sort()).toEqual([1, 2, 3]);
    expect(stored().map(([id]) => id).sort()).toEqual(['row-1', 'row-3']);
  });
});
