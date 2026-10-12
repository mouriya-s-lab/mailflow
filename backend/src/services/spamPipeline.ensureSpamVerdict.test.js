import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./spamModelStore.js', () => ({ getModelForUser: vi.fn() }));
vi.mock('./logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../fork-features/headers/index.js', () => ({ getMessageHeaders: vi.fn() }));

import { query } from './db.js';
import { getModelForUser } from './spamModelStore.js';
import { logger } from './logger.js';
import { getMessageHeaders } from '../../fork-features/headers/index.js';
import { ensureSpamVerdict } from './spamPipeline.js';
import { createEmptyModel, updateIncremental } from './spamModel.js';

const MESSAGE_ID = 'mmmmmmmm-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// The verdict-state read of ensureSpamVerdict.
function stateRow(overrides = {}) {
  return {
    spam_analyzed_at: null,
    spam_verdict: null,
    spam_user_override: null,
    antispam_enabled: true,
    master_spam_enabled: null,
    ...overrides,
  };
}

// The row classifyAndTagMessage reads.
function classifyRow(overrides = {}) {
  return {
    id: MESSAGE_ID,
    account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    owner_id: 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu',
    account_email: 'user@example.com',
    antispam_enabled: true,
    master_spam_enabled: null,
    folder_mappings: { spam: 'Junk' },
    trusted_authserv_id: 'mx.example.com',
    folder: 'INBOX',
    uid: 100,
    message_id: '<old-1@mailflow-test.invalid>',
    subject: 'Cheap viagra offer, click and buy free',
    body_text: 'cheap viagra click buy offer free',
    body_html: null,
    from_email: 'sender@example.net',
    attachments: [],
    spam_user_override: null,
    spam_verdict: null,
    spam_analyzed_at: null,
    ...overrides,
  };
}

function trainedModel(records) {
  let model = createEmptyModel();
  const spamWords = ['cheap', 'viagra', 'click', 'buy', 'offer', 'free'];
  const hamWords = ['meeting', 'agenda', 'notes', 'review', 'document', 'thanks'];
  for (let i = 0; i < records; i += 1) {
    const isSpam = i % 2 === 0;
    model = updateIncremental(model, isSpam ? spamWords : hamWords, {}, isSpam ? 'spam' : 'ham');
  }
  return model;
}

const HEADERS = { 'authentication-results': 'mx.example.com; dkim=fail header.d=example.net; spf=fail; dmarc=fail' };

function storedHeaders() {
  getMessageHeaders.mockResolvedValue(new Map([[MESSAGE_ID, { kind: 'stored', headers: HEADERS, source: 'imap_fetch' }]]));
}

const verdictUpdates = () => query.mock.calls.filter(([sql]) => sql.includes('UPDATE messages SET'));

beforeEach(() => {
  query.mockReset();
  getModelForUser.mockReset();
  getMessageHeaders.mockReset();
  logger.warn.mockReset();
  getModelForUser.mockResolvedValue(trainedModel(200));
});

describe('ensureSpamVerdict', () => {
  it('returns the stored verdict of an analyzed message without classifying it again', async () => {
    query.mockResolvedValueOnce({ rows: [stateRow({ spam_analyzed_at: '2026-10-01T00:00:00Z', spam_verdict: 'ham', spam_user_override: 'ham' })] });
    await expect(ensureSpamVerdict(MESSAGE_ID)).resolves.toEqual({ kind: 'verdict', verdict: 'ham', override: 'ham' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(getMessageHeaders).not.toHaveBeenCalled();
  });

  it('returns the stored verdict even when anti-spam has since been switched off', async () => {
    query.mockResolvedValueOnce({ rows: [stateRow({ spam_analyzed_at: '2026-10-01T00:00:00Z', spam_verdict: 'unsure', antispam_enabled: false })] });
    await expect(ensureSpamVerdict(MESSAGE_ID)).resolves.toEqual({ kind: 'verdict', verdict: 'unsure', override: null });
  });

  it('classifies an unanalyzed message on the spot with its retained headers, tags it and never moves it', async () => {
    storedHeaders();
    query.mockResolvedValueOnce({ rows: [stateRow()] });
    query.mockResolvedValueOnce({ rows: [classifyRow()] });
    query.mockResolvedValue({ rows: [] });

    await expect(ensureSpamVerdict(MESSAGE_ID)).resolves.toEqual({ kind: 'verdict', verdict: 'spam', override: null });

    expect(getMessageHeaders).toHaveBeenCalledWith([MESSAGE_ID]);
    const updates = verdictUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toContain('spam_analyzed_at = NOW()');
    expect(updates[0][0]).not.toMatch(/folder\s*=/);
    const details = JSON.parse(updates[0][1][2]);
    // The retained Authentication-Results reached the classifier and its trusted id was honoured.
    expect(details.authservIds).toEqual(['mx.example.com']);
    expect(details.authTrusted).toBe(true);
    // High enough to auto-move, but the move was deferred: nothing moved.
    expect(details.autoMoveDeferred).toBe(true);
    expect(query.mock.calls.some(([sql]) => /DELETE FROM messages/.test(sql))).toBe(false);
  });

  it.each([
    ['the account anti-spam switch is off', { antispam_enabled: false }],
    ["the user's master switch is off", { master_spam_enabled: 'false' }],
  ])('is disabled when %s', async (_label, overrides) => {
    query.mockResolvedValueOnce({ rows: [stateRow(overrides)] });
    await expect(ensureSpamVerdict(MESSAGE_ID)).resolves.toEqual({ kind: 'disabled' });
    expect(getMessageHeaders).not.toHaveBeenCalled();
    expect(verdictUpdates()).toHaveLength(0);
  });

  it('is an error, logged, when the classification throws', async () => {
    storedHeaders();
    query.mockResolvedValueOnce({ rows: [stateRow()] });
    query.mockResolvedValueOnce({ rows: [classifyRow()] });
    getModelForUser.mockRejectedValue(new Error('connection terminated'));

    await expect(ensureSpamVerdict(MESSAGE_ID)).resolves.toEqual({ kind: 'error', reason: 'connection terminated' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(verdictUpdates()).toHaveLength(0);
  });

  it.each([
    ['imap_error', 'headers_imap_error'],
    ['not_on_server', 'headers_not_on_server'],
    ['message_missing', 'message_missing'],
  ])('is an error and classifies nothing when the headers are unavailable (%s)', async (reason, expected) => {
    getMessageHeaders.mockResolvedValue(new Map([[MESSAGE_ID, { kind: 'unavailable', reason }]]));
    query.mockResolvedValueOnce({ rows: [stateRow()] });

    await expect(ensureSpamVerdict(MESSAGE_ID)).resolves.toEqual({ kind: 'error', reason: expected });
    expect(query).toHaveBeenCalledTimes(1);
    expect(getModelForUser).not.toHaveBeenCalled();
  });

  it('is an error for a row that does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(ensureSpamVerdict(MESSAGE_ID)).resolves.toEqual({ kind: 'error', reason: 'message_missing' });
  });

  it('reports the current state when the row changed between the read and the classification', async () => {
    storedHeaders();
    query.mockResolvedValueOnce({ rows: [stateRow()] });
    // The user marked it meanwhile: the classifier skips it, and the row now carries the mark.
    query.mockResolvedValueOnce({ rows: [classifyRow({ spam_user_override: 'spam' })] });
    query.mockResolvedValueOnce({ rows: [stateRow({ spam_analyzed_at: '2026-10-12T00:00:00Z', spam_verdict: 'spam', spam_user_override: 'spam' })] });

    await expect(ensureSpamVerdict(MESSAGE_ID)).resolves.toEqual({ kind: 'verdict', verdict: 'spam', override: 'spam' });
    expect(verdictUpdates()).toHaveLength(0);
  });

  it('is disabled when the switch was turned off between the read and the classification', async () => {
    storedHeaders();
    query.mockResolvedValueOnce({ rows: [stateRow()] });
    query.mockResolvedValueOnce({ rows: [classifyRow({ antispam_enabled: false })] });
    query.mockResolvedValueOnce({ rows: [stateRow({ antispam_enabled: false })] });

    await expect(ensureSpamVerdict(MESSAGE_ID)).resolves.toEqual({ kind: 'disabled' });
  });
});
