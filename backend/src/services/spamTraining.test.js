import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn(fn => fn({ query })) }));
vi.mock('./logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
// The real retrain over the mocked query layer; only incremental training is a spy.
vi.mock('./spamModelStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  updateIncrementalForUser: vi.fn(),
}));
vi.mock('../../fork-features/headers/index.js', () => ({ getMessageHeaders: vi.fn() }));
vi.mock('../../fork-features/reputation/index.js', () => ({ lookupDomains: vi.fn() }));

import { query } from './db.js';
import { logger } from './logger.js';
import { updateIncrementalForUser } from './spamModelStore.js';
import { captureManualSpamLabel, recordJevSpamVerdict, requestSpamRetrain } from './spamTraining.js';
import { getMessageHeaders } from '../../fork-features/headers/index.js';
import { lookupDomains } from '../../fork-features/reputation/index.js';
import { TOKENIZER_VERSION } from './spamTokenizer.js';
import { flagTokensFor } from './spamModel.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function messageRow(overrides = {}) {
  return {
    id: MESSAGE_ID,
    account_id: ACCOUNT_ID,
    owner_id: USER_ID,
    uid: 42,
    folder: 'INBOX',
    message_id: '<abc123@mailflow-test.invalid>',
    subject: 'Cheap pills',
    body_text: 'Buy cheap pills now',
    body_html: '<p>Buy cheap pills now</p>',
    from_email: 'seller@Example.COM',
    attachments: [{ filename: 'list.pdf.exe' }],
    ...overrides,
  };
}

const inserts = () => query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO spam_training_log'));

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  getMessageHeaders.mockReset();
  getMessageHeaders.mockResolvedValue(new Map([[MESSAGE_ID, { kind: 'stored', headers: { 'content-language': 'en' } }]]));
  logger.warn.mockReset();
  updateIncrementalForUser.mockReset();
  lookupDomains.mockReset();
});

describe('recordJevSpamVerdict', () => {
  it('records a jev row with the full feature columns and no incremental training', async () => {
    query.mockResolvedValueOnce({ rows: [messageRow()] });
    query.mockResolvedValueOnce({ rows: [{ id: 'new-record' }] });

    await expect(recordJevSpamVerdict({ messageId: MESSAGE_ID, label: 'spam' })).resolves.toEqual({ kind: 'recorded' });

    expect(inserts()).toHaveLength(1);
    const [sql, params] = inserts()[0];
    expect(sql).toContain("'jev'");
    expect(sql.replace(/\s+/g, ' ')).toContain(
      "ON CONFLICT (user_id, account_id, message_id_header) WHERE source = 'jev' AND message_id_header IS NOT NULL DO NOTHING",
    );
    expect(params.slice(0, 6)).toEqual([USER_ID, ACCOUNT_ID, '<abc123@mailflow-test.invalid>', 42, 'INBOX', 'spam']);
    const [subject, bodyText, bodyHtml, tokenCounts, flagFeatures, senderDomain, attachmentTypes] = params.slice(6);
    expect(subject).toBe('Cheap pills');
    expect(bodyText).toBe('Buy cheap pills now');
    expect(bodyHtml).toBe('<p>Buy cheap pills now</p>');
    // Subject, text body and HTML body are all tokenized.
    expect(JSON.parse(tokenCounts)).toMatchObject({ cheap: 3, pills: 3 });
    expect(JSON.parse(flagFeatures)).toMatchObject({ has_attachment: 1, attachment_is_executable: 1 });
    expect(senderDomain).toBe('example.com');
    expect(attachmentTypes).toEqual(['exe']);
    expect(params).toHaveLength(15);
    expect(params.slice(13)).toEqual(['en', TOKENIZER_VERSION]);
    expect(getMessageHeaders).toHaveBeenCalledWith([MESSAGE_ID], { deadlineMs: 10_000 });
    expect(updateIncrementalForUser).not.toHaveBeenCalled();
  });

  it('is a duplicate when the account already has a jev record for that Message-ID', async () => {
    query.mockResolvedValueOnce({ rows: [messageRow()] });
    query.mockResolvedValueOnce({ rows: [] }); // ON CONFLICT DO NOTHING returned no row
    await expect(recordJevSpamVerdict({ messageId: MESSAGE_ID, label: 'ham' })).resolves.toEqual({ kind: 'duplicate' });
  });

  it('records nothing for a message without a Message-ID', async () => {
    query.mockResolvedValueOnce({ rows: [messageRow({ message_id: null })] });
    await expect(recordJevSpamVerdict({ messageId: MESSAGE_ID, label: 'spam' })).resolves.toEqual({ kind: 'no_message_id' });
    expect(inserts()).toHaveLength(0);
  });

  it('records nothing for a row that does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(recordJevSpamVerdict({ messageId: MESSAGE_ID, label: 'spam' })).resolves.toEqual({ kind: 'message_missing' });
    expect(inserts()).toHaveLength(0);
  });

  it('rejects a label other than spam or ham', async () => {
    await expect(recordJevSpamVerdict({ messageId: MESSAGE_ID, label: 'unsure' })).rejects.toThrow(TypeError);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('captureManualSpamLabel', () => {
  it('records a manual row with the placement given after the move and trains incrementally', async () => {
    query.mockResolvedValueOnce({ rows: [messageRow({ folder: 'Junk', uid: 7 })] });
    const mark = await captureManualSpamLabel({ userId: USER_ID, messageId: MESSAGE_ID, label: 'ham' });
    expect(mark.kind).toBe('captured');
    query.mockResolvedValue({ rows: [] });

    await mark.record({ uid: 300, folder: 'INBOX' });

    const [sql, params] = inserts()[0];
    expect(sql).toContain("'manual'");
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
    expect(params.slice(0, 6)).toEqual([USER_ID, ACCOUNT_ID, '<abc123@mailflow-test.invalid>', 300, 'INBOX', 'ham']);
    expect(updateIncrementalForUser).toHaveBeenCalledWith(
      USER_ID,
      'en',
      expect.arrayContaining(['cheap', 'pills']),
      expect.objectContaining({ has_attachment: 1, attachment_is_executable: 1 }),
      'ham',
    );
  });

  it("does not capture another user's message", async () => {
    query.mockResolvedValueOnce({ rows: [messageRow({ owner_id: 'someone-else' })] });
    await expect(captureManualSpamLabel({ userId: USER_ID, messageId: MESSAGE_ID, label: 'spam' }))
      .resolves.toEqual({ kind: 'message_missing' });
  });
});

describe('link flags in the training record (mouriya-s-lab/mailflow#16)', () => {
  const PHISH_HTML = '<p>Verify your account</p><a href="https://cmb-verify-login.xyz/login">www.cmbchina.com</a>';
  const freshDomain = () => new Map([['cmb-verify-login.xyz', {
    registration: { kind: 'known', registeredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
    listings: { spamhaus_dbl: { kind: 'unconfigured' }, urlhaus: { kind: 'unconfigured' } },
  }]]);
  const recordedFlags = () => JSON.parse(inserts()[0][1][10]);

  it('a mark snapshots the three flags as they are at marking time and trains on their tokens', async () => {
    lookupDomains.mockResolvedValue(freshDomain());
    query.mockResolvedValueOnce({ rows: [messageRow({ body_html: PHISH_HTML, antispam_enabled: true, master_spam_enabled: null })] });
    const mark = await captureManualSpamLabel({ userId: USER_ID, messageId: MESSAGE_ID, label: 'spam' });
    expect(lookupDomains).toHaveBeenCalledTimes(1);
    await mark.record({ uid: 9, folder: 'Junk' });

    expect(recordedFlags()).toMatchObject({ link_text_domain_mismatch: 1, link_domain_new: 1, link_domain_listed: null });
    const flagTokens = flagTokensFor(updateIncrementalForUser.mock.calls[0][3]);
    expect(flagTokens).toEqual(expect.arrayContaining(['__link_text_domain_mismatch__', '__link_domain_new__']));
    expect(flagTokens).not.toContain('__link_domain_listed__');
  });

  it('a Jev record carries the same snapshot', async () => {
    lookupDomains.mockResolvedValue(freshDomain());
    query.mockResolvedValueOnce({ rows: [messageRow({ body_html: PHISH_HTML, antispam_enabled: true })] });
    query.mockResolvedValueOnce({ rows: [{ id: 'new-record' }] });
    await recordJevSpamVerdict({ messageId: MESSAGE_ID, label: 'spam' });
    expect(recordedFlags()).toMatchObject({ link_text_domain_mismatch: 1, link_domain_new: 1, link_domain_listed: null });
  });

  it('with anti-spam off for the account no lookup is made and the reputation flags are null', async () => {
    query.mockResolvedValueOnce({ rows: [messageRow({ body_html: PHISH_HTML, antispam_enabled: false })] });
    const mark = await captureManualSpamLabel({ userId: USER_ID, messageId: MESSAGE_ID, label: 'spam' });
    await mark.record({ uid: 9, folder: 'Junk' });
    expect(lookupDomains).not.toHaveBeenCalled();
    expect(recordedFlags()).toMatchObject({ link_text_domain_mismatch: 1, link_domain_new: null, link_domain_listed: null });
  });

  it('a retrain uses the recorded snapshot and makes no lookup', async () => {
    const linked = { link_text_domain_mismatch: 1, link_domain_new: 1, link_domain_listed: null };
    query.mockImplementation(sql => Promise.resolve(sql.includes('SELECT t.language') ? {
      rows: [
        { language: 'en', label: 'spam', created_at: new Date().toISOString(), token_counts: { pills: 1 }, flag_features: linked },
        { language: 'en', label: 'ham', created_at: new Date().toISOString(), token_counts: { meeting: 1 }, flag_features: {} },
      ],
    } : { rows: [] }));

    await expect(requestSpamRetrain('user-links')).resolves.toEqual({ kind: 'retrained', records: 2 });
    expect(lookupDomains).not.toHaveBeenCalled();
    const saved = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO spam_models'));
    const vocabulary = JSON.parse(saved[1].find(p => typeof p === 'string' && p.includes('__link_domain_new__')));
    expect(vocabulary.__link_domain_new__).toEqual({ spam: 1, ham: 0 });
    expect(vocabulary.__link_text_domain_mismatch__).toEqual({ spam: 1, ham: 0 });
    expect(vocabulary.__link_domain_listed__).toBeUndefined();
  });
});

describe('requestSpamRetrain', () => {
  const now = () => new Date().toISOString();
  const trainingRows = () => ({
    rows: [
      { language: 'en', label: 'spam', created_at: now(), token_counts: { pills: 2 }, flag_features: {} },
      { language: 'en', label: 'ham', created_at: now(), token_counts: { meeting: 1 }, flag_features: {} },
    ],
  });

  it('reports no_training_data for a user without training records', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(requestSpamRetrain('user-empty')).resolves.toEqual({ kind: 'no_training_data' });
  });

  it('runs one retrain per user at a time: a concurrent request is already_running', async () => {
    let release;
    const trainingLog = new Promise(resolve => { release = resolve; });
    query.mockImplementation(sql => {
      if (sql.includes('SELECT t.language')) return trainingLog;
      return Promise.resolve({ rows: [] });
    });

    const first = requestSpamRetrain('user-a');
    const second = requestSpamRetrain('user-a');
    await expect(second).resolves.toEqual({ kind: 'already_running' });

    // Another user is not held up by user-a's retrain.
    const other = requestSpamRetrain('user-b');
    release(trainingRows());
    await expect(first).resolves.toEqual({ kind: 'retrained', records: 2 });
    await expect(other).resolves.toEqual({ kind: 'retrained', records: 2 });
    expect(query.mock.calls.filter(([sql]) => sql.includes('SELECT t.language'))).toHaveLength(2);

    // Once settled, the user can retrain again.
    query.mockImplementation(sql => Promise.resolve(sql.includes('SELECT t.language') ? trainingRows() : { rows: [] }));
    await expect(requestSpamRetrain('user-a')).resolves.toEqual({ kind: 'retrained', records: 2 });
  });

  it('reports failed with the reason when the retrain throws, and frees the user', async () => {
    query.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
    await expect(requestSpamRetrain('user-c')).resolves.toEqual({
      kind: 'failed', reason: 'canceling statement due to statement timeout',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    query.mockResolvedValueOnce({ rows: [] });
    await expect(requestSpamRetrain('user-c')).resolves.toEqual({ kind: 'no_training_data' });
  });
});
