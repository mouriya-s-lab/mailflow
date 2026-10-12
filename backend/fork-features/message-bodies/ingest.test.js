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

// New mail, already read on another device, ingested by live sync, a first sync or a backfill.
// Every row must be inserted with its body before anti-spam classifies it, on every provider
// profile (#38 in mouriya-s-lab/mailflow), and the way the body is asked for must suit the
// server: Gmail fails a whole FETCH that names a part one of its messages lacks.
const HTML = '<p>Your statement is ready: <a href="https://bank.example/s">view</a></p>';
const TEXT = 'Your statement is ready: https://bank.example/s';
const SINGLE = { type: 'text/html', encoding: '7bit', parameters: { charset: 'utf-8' } };
const ALTERNATIVE = {
  type: 'multipart/alternative',
  childNodes: [
    { part: '1', type: 'text/plain', encoding: '7bit', parameters: { charset: 'utf-8' } },
    { part: '2', type: 'text/html', encoding: '7bit', parameters: { charset: 'utf-8' } },
  ],
};
// uid 5 is a single-part HTML message (its one part is 1), uid 6 a multipart/alternative one.
const SERVER = [
  { uid: 5, structure: SINGLE, parts: { 1: HTML } },
  { uid: 6, structure: ALTERNATIVE, parts: { 1: TEXT, 2: HTML } },
];

const noFetch = () => Object.assign(new Error('Command failed'), { responseStatus: 'NO', responseText: 'Some messages could not be FETCHed (Failure)' });

// How the fake server answers a FETCH naming body parts:
//   refusesMissingParts — NO for the whole FETCH when a message lacks a named part (Gmail);
//                         otherwise an absent part is just left out (Outlook, most servers).
//   malformsSiblings    — a FETCH naming several parts returns each as an empty literal (the
//                         PurelyMail behaviour its provider profile records); one part is fine.
//   failsParts          — part numbers whose own FETCH fails.
let server, calls, inserts, events, cachedUids;

function client() {
  const messages = SERVER;
  const select = (range, options) => {
    if (range.includes(':')) {
      const lo = Number(range.split(':')[0]);
      return options?.uid ? messages.filter(m => m.uid >= lo) : messages;
    }
    const wanted = new Set(range.split(',').map(Number));
    return messages.filter(m => wanted.has(m.uid));
  };
  return Object.assign(new EventEmitter(), {
    mailbox: { exists: messages.length, uidValidity: 1 },
    connect: vi.fn().mockResolvedValue(), close: vi.fn(), logout: vi.fn().mockResolvedValue(),
    noop: vi.fn(async () => true),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    search: vi.fn(async () => messages.map(m => m.uid)),
    fetch: vi.fn(async function* (range, fetchQuery, options) {
      calls.push({ range, query: fetchQuery, options });
      const selected = select(range, options);
      const parts = fetchQuery.bodyParts || [];
      if (parts.length) {
        if (server.refusesMissingParts && selected.some(m => parts.some(p => !(p in m.parts)))) throw noFetch();
        if (!fetchQuery.envelope && parts.some(p => server.failsParts.has(p))) throw noFetch();
      }
      for (const m of selected) {
        const bodyParts = new Map(parts.filter(p => p in m.parts)
          .map(p => [p, Buffer.from(parts.length > 1 && server.malformsSiblings ? '' : m.parts[p])]));
        if (fetchQuery.envelope) {
          yield {
            uid: m.uid,
            flags: new Set(['\\Seen']),
            internalDate: new Date('2026-10-01T00:00:00Z'),
            envelope: { messageId: `<m${m.uid}@mailflow-test.invalid>`, subject: 'Statement', from: [{ name: 'Bank', address: 'notice@bank.example' }], to: [], cc: [] },
            bodyStructure: m.structure,
            headers: Buffer.from('From: Bank <notice@bank.example>\r\nSubject: Statement\r\n\r\n'),
            ...(parts.length ? { bodyParts } : {}),
          };
        } else if (parts.length) {
          yield { uid: m.uid, bodyParts };
        } else {
          yield { uid: m.uid, flags: new Set(['\\Seen']) };
        }
      }
    }),
  });
}

const accountFor = host => ({ id: 'acct-1', user_id: 'u1', enabled: true, imap_tls: true, email_address: 'me@example.test', imap_host: host });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  server = { refusesMissingParts: false, malformsSiblings: false, failsParts: new Set() };
  calls = []; inserts = new Map(); events = []; cachedUids = new Set();
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'] });
  ImapFlow.mockImplementation(function () { return client(); });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function database(account) {
  query.mockReset().mockImplementation(async (sql, params = []) => {
    if (sql.includes('INSERT INTO messages')) {
      const uid = Number(params[1]);
      inserts.set(uid, { bodyHtml: params[17], bodyText: params[18] });
      events.push(`insert ${uid}`);
      const isNew = !cachedUids.has(uid);
      cachedUids.add(uid);
      return { rows: [{ id: `row-${uid}`, is_new: isNew }] };
    }
    if (sql.includes('SELECT * FROM email_accounts') || sql.includes('SELECT id FROM email_accounts')) return { rows: [account] };
    if (sql.includes('SELECT uid_validity')) return { rows: [{ uid_validity: 1, highest_modseq: null }] };
    if (sql.includes('COUNT(*) as count')) return { rows: [{ count: cachedUids.size, max_uid: Math.max(0, ...cachedUids) }] };
    if (sql.includes('COALESCE(MAX(uid), 0)')) return { rows: [{ max_uid: Math.max(0, ...cachedUids) }] };
    if (sql.trim().startsWith('SELECT') && sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
    if (sql.includes('SELECT uid FROM messages')) return { rows: [...cachedUids].map(uid => ({ uid })) };
    return { rows: [] };
  });
}

const manager = () => ({ backfillRunning: new Set(), broadcast: vi.fn(), pluginFacade: {}, _secondaryConnectBlocked: () => null,
  _noteSecondaryRefusal: vi.fn(), _applyFlagUpdates: ImapManager.prototype._applyFlagUpdates,
  maybeClassifyNewMessage: vi.fn((account, id) => { events.push(`classify ${id.slice(4)}`); }) });

// live sync: uid 4 is already cached, so 5 and 6 come in through the new-UID phase.
// first sync: nothing is cached, so they come in through the full scan.
// backfill: the missing UIDs, newest first, on the backfill's own connection.
const ingest = {
  'live sync': async account => {
    cachedUids.add(4);
    const pending = ImapManager.prototype.syncMessages.call(manager(), account, client(), 'INBOX', 20);
    await vi.runAllTimersAsync();
    await pending;
    expect(calls.some(c => c.range === '5:*' && c.query.envelope)).toBe(true);
  },
  'first sync': async account => {
    const pending = ImapManager.prototype.syncMessages.call(manager(), account, client(), 'INBOX', 20);
    await vi.runAllTimersAsync();
    await pending;
  },
  backfill: async account => {
    const pending = ImapManager.prototype.backfillMessages.call(manager(), account, 'INBOX');
    await vi.runAllTimersAsync();
    await pending;
  },
};
const paths = Object.keys(ingest);
const bodyCalls = () => calls.filter(c => c.query.bodyParts?.length);
// Each message's row is inserted, then classified, before the next message's row; the server
// answers in UID order.
const INSERTED_THEN_CLASSIFIED = ['insert 5', 'classify 5', 'insert 6', 'classify 6'];

describe('a new message is ingested with its body', () => {
  it.each(paths.flatMap(path => [
    ['Microsoft', 'outlook.office365.com', path],
    ['generic', 'imap.example.test', path],
  ]))('%s (%s), %s: the body comes in the same FETCH as the message', async (name, host, path) => {
    const account = accountFor(host);
    database(account);

    await ingest[path](account);

    expect(bodyCalls().length).toBeGreaterThan(0);
    expect(bodyCalls().every(c => c.query.envelope)).toBe(true);
    expect(inserts.get(5)).toEqual({ bodyHtml: expect.stringContaining('https://bank.example/s'), bodyText: null });
    expect(inserts.get(6)).toEqual({ bodyHtml: expect.stringContaining('https://bank.example/s'), bodyText: TEXT });
    expect(events).toEqual(INSERTED_THEN_CLASSIFIED);
  });

  it.each(paths)('Google, %s: no FETCH names a part a message lacks; the parts its structure names come in a second FETCH', async path => {
    server.refusesMissingParts = true;
    const account = accountFor('imap.gmail.com');
    database(account);

    await ingest[path](account);

    // The message FETCH carries no body part, and each part FETCH names one part, of the
    // messages whose structure has it, by UID.
    expect(calls.filter(c => c.query.envelope && c.query.bodyParts)).toEqual([]);
    const partCalls = bodyCalls().map(c => ({ uids: c.range.split(',').map(Number).sort(), parts: c.query.bodyParts, uid: c.options?.uid }));
    expect(partCalls).toEqual([{ uids: [5, 6], parts: ['1'], uid: true }, { uids: [6], parts: ['2'], uid: true }]);
    expect(inserts.get(5)).toEqual({ bodyHtml: expect.stringContaining('https://bank.example/s'), bodyText: null });
    expect(inserts.get(6)).toEqual({ bodyHtml: expect.stringContaining('https://bank.example/s'), bodyText: TEXT });
    expect(events).toEqual(INSERTED_THEN_CLASSIFIED);
  });

  it.each(paths)('PurelyMail, %s: no FETCH asks for sibling parts together, so no part arrives malformed', async path => {
    server.malformsSiblings = true;
    const account = accountFor('mailserver.purelymail.com');
    database(account);

    await ingest[path](account);

    expect(bodyCalls().every(c => c.query.bodyParts.length === 1 && !c.query.envelope)).toBe(true);
    expect(inserts.get(6)).toEqual({ bodyHtml: expect.stringContaining('https://bank.example/s'), bodyText: TEXT });
  });

  it.each(paths)('Google, %s: a message whose part failed to fetch is still stored and classified, without any body', async path => {
    server.refusesMissingParts = true;
    server.failsParts.add('2');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const account = accountFor('imap.gmail.com');
    database(account);

    await ingest[path](account);

    // uid 6 got its part 1 but not its part 2: half a body is not stored, so the row stays empty
    // for ensureMessageBodies to fill. uid 5 needs no part 2 and keeps its body.
    expect(inserts.get(6)).toEqual({ bodyHtml: null, bodyText: null });
    expect(inserts.get(5)).toEqual({ bodyHtml: expect.stringContaining('https://bank.example/s'), bodyText: null });
    expect(events).toEqual(INSERTED_THEN_CLASSIFIED);
    const partWarnings = warn.mock.calls.map(([msg]) => msg).filter(msg => msg.includes('not fetched'));
    expect(partWarnings).toEqual([expect.stringMatching(/Body part 2 not fetched for 1 message\(s\).*Some messages could not be FETCHed/)]);
  });
});
