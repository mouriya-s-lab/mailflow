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

import { query } from '../../src/services/db.js';
import { ImapManager } from '../../src/services/imapManager.js';

// Live sync of one new message, already read on another device, from a server that hands out
// its body parts only when the FETCH asks for them. The row must be inserted with its body
// before anti-spam classifies it, on every provider profile (#38 in mouriya-s-lab/mailflow).
const HTML = '<p>Your statement is ready: <a href="https://bank.example/s">view</a></p>';
const message = (uid, fetchQuery) => ({
  uid,
  flags: new Set(['\\Seen']),
  internalDate: new Date('2026-10-01T00:00:00Z'),
  envelope: { messageId: `<m${uid}@mailflow-test.invalid>`, subject: 'Statement', from: [{ name: 'Bank', address: 'notice@bank.example' }], to: [], cc: [] },
  bodyStructure: { part: '1', type: 'text/html', encoding: '7bit', parameters: { charset: 'utf-8' } },
  headers: Buffer.from('From: Bank <notice@bank.example>\r\nSubject: Statement\r\n\r\n'),
  ...(fetchQuery.bodyParts ? { bodyParts: new Map([['1', Buffer.from(HTML)]]) } : {}),
});

let inserts, events;

function client() {
  return Object.assign(new EventEmitter(), {
    mailbox: { exists: 1, uidValidity: 1 },
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    noop: vi.fn(async () => true),
    fetch: vi.fn(async function* (range, fetchQuery) {
      if (fetchQuery.envelope) yield message(1, fetchQuery);
    }),
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  inserts = []; events = [];
  query.mockReset().mockImplementation(async (sql, params = []) => {
    if (sql.includes('INSERT INTO messages')) {
      inserts.push({ bodyHtml: params[17], bodyText: params[18] });
      events.push('insert');
      return { rows: [{ id: 'row-1', is_new: true }] };
    }
    if (sql.includes('SELECT uid_validity')) return { rows: [{ uid_validity: 1, highest_modseq: null }] };
    if (sql.includes('COALESCE(MAX(uid), 0)')) return { rows: [{ max_uid: 0 }] };
    if (sql.trim().startsWith('SELECT') && sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
    return { rows: [] };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const manager = () => ({ backfillRunning: new Set(), broadcast: vi.fn(), pluginFacade: {}, _secondaryConnectBlocked: () => null,
  _noteSecondaryRefusal: vi.fn(), _applyFlagUpdates: ImapManager.prototype._applyFlagUpdates,
  maybeClassifyNewMessage: vi.fn(() => { events.push('classify'); }) });

describe('a new message is ingested with its body', () => {
  it.each([
    ['Microsoft', { imap_host: 'outlook.office365.com' }],
    ['Google', { imap_host: 'imap.gmail.com' }],
    ['generic', { imap_host: 'imap.example.test' }],
  ])('%s: live sync stores body_html from the same FETCH, before anti-spam sees the row', async (name, host) => {
    const account = { id: `acct-${name}`, user_id: 'u1', enabled: true, imap_tls: true, email_address: 'me@example.test', ...host };
    const imap = client();
    const mgr = manager();

    await ImapManager.prototype.syncMessages.call(mgr, account, imap, 'INBOX', 20);

    expect(imap.fetch.mock.calls.some(([, q]) => q.envelope && q.bodyParts)).toBe(true);
    expect(inserts).toEqual([{ bodyHtml: expect.stringContaining('Your statement is ready'), bodyText: null }]);
    expect(inserts[0].bodyHtml).toContain('https://bank.example/s');
    expect(events).toEqual(['insert', 'classify']);
  });
});
