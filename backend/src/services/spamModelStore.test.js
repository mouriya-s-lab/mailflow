import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(fn => fn({ query })),
}));

import { query, withTransaction } from './db.js';
import { countTokens, tokenize, TOKENIZER_VERSION } from './spamTokenizer.js';
import { createEmptyModel } from './spamModel.js';
import {
  getModelsForUser,
  getModelForUser,
  saveModel,
  updateIncrementalForUser,
  invalidateModelCache,
  getDecayThresholdDays,
  setDecayThresholdDays,
  getAllUsersWithTraining,
  getAllUsersWithTrainingLog,
  retrainUser,
} from './spamModelStore.js';

const USER_ID = 'test-user';
const NOW = new Date('2026-08-18T00:00:00Z');
const row = (overrides = {}) => ({
  language: 'en',
  vocabulary: { viagra: { spam: 5, ham: 0 }, meeting: { spam: 0, ham: 3 } },
  total_spam: 5,
  total_ham: 3,
  prior_spam: 5 / 8,
  prior_ham: 3 / 8,
  training_records: 8,
  model_version: 1,
  last_trained_at: NOW.toISOString(),
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  query.mockReset();
  withTransaction.mockClear();
  invalidateModelCache(USER_ID);
  invalidateModelCache('other-user');
  query.mockResolvedValue({ rows: [] });
});

afterEach(() => vi.useRealTimers());

describe('partition lookup and per-user cache', () => {
  it('returns an empty map and null partition for a cold-start user', async () => {
    await expect(getModelsForUser(USER_ID)).resolves.toEqual(new Map());
    await expect(getModelForUser(USER_ID, 'en')).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('maps all language partitions and looks up only the requested one', async () => {
    query.mockResolvedValueOnce({ rows: [row(), row({ language: 'fr', training_records: 30 })] });
    const partitions = await getModelsForUser(USER_ID);
    expect([...partitions.keys()]).toEqual(['en', 'fr']);
    expect(partitions.get('en')).toMatchObject({
      vocabulary: row().vocabulary, totalSpam: 5, totalHam: 3,
      trainingRecords: 8, lastTrainedAt: NOW.toISOString(),
    });
    await expect(getModelForUser(USER_ID, 'fr')).resolves.toBe(partitions.get('fr'));
    await expect(getModelForUser(USER_ID, 'ja')).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('shares a cache across one user\'s partitions but never across users', async () => {
    query.mockResolvedValueOnce({ rows: [row(), row({ language: 'fr' })] });
    query.mockResolvedValueOnce({ rows: [row({ total_spam: 0, total_ham: 50 })] });
    expect((await getModelForUser(USER_ID, 'en')).totalSpam).toBe(5);
    await getModelForUser(USER_ID, 'fr');
    expect((await getModelForUser('other-user', 'en')).totalSpam).toBe(0);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([, params]) => params)).toEqual([[USER_ID], ['other-user']]);
  });

  it('refreshes all partitions after the five-minute cache lifetime', async () => {
    query.mockResolvedValueOnce({ rows: [row()] });
    await getModelsForUser(USER_ID);
    vi.advanceTimersByTime(5 * 60 * 1000);
    query.mockResolvedValueOnce({ rows: [row({ language: 'ja' })] });
    expect([...(await getModelsForUser(USER_ID)).keys()]).toEqual(['ja']);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('saveModel and incremental training', () => {
  it('persists the requested partition and invalidates the whole user cache', async () => {
    query.mockResolvedValueOnce({ rows: [row()] });
    await getModelsForUser(USER_ID);
    const model = createEmptyModel();
    await saveModel(USER_ID, 'fr', model);
    expect(query.mock.calls[1][1]).toEqual([
      USER_ID, 'fr', JSON.stringify(model.vocabulary), model.totalSpam, model.totalHam,
      model.priorSpam, model.priorHam, model.trainingRecords, model.modelVersion,
      expect.any(String),
    ]);
    query.mockResolvedValueOnce({ rows: [row({ language: 'fr' })] });
    expect([...(await getModelsForUser(USER_ID)).keys()]).toEqual(['fr']);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('trains and saves one cold-start language partition from supplied tokens', async () => {
    const model = await updateIncrementalForUser(USER_ID, 'en', ['viagra', 'click'], { has_attachment: 1 }, 'spam');
    expect(model.trainingRecords).toBe(1);
    expect(model.vocabulary.viagra).toEqual({ spam: 1, ham: 0 });
    expect(model.vocabulary.__has_attachment__).toEqual({ spam: 1, ham: 0 });
    expect(query.mock.calls[1][1].slice(0, 3)).toEqual([USER_ID, 'en', JSON.stringify(model.vocabulary)]);
  });

  it('does no reads or writes for invalid labels', async () => {
    await expect(updateIncrementalForUser(USER_ID, 'en', ['viagra'], {}, 'neither')).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('decay preferences', () => {
  it('uses 90 days when the preference is absent and reads the stored integer', async () => {
    await expect(getDecayThresholdDays(USER_ID)).resolves.toBe(90);
    query.mockResolvedValueOnce({ rows: [{ days: 30 }] });
    await expect(getDecayThresholdDays(USER_ID)).resolves.toBe(30);
  });

  it('writes the per-user preference', async () => {
    await setDecayThresholdDays(USER_ID, 30);
    expect(query.mock.calls[0][1]).toEqual([USER_ID, 30]);
  });
});

describe('retrainUser', () => {
  it('returns no_training_data without replacing any partitions when no records exist', async () => {
    await expect(retrainUser(USER_ID)).resolves.toMatchObject({ ok: false, recordsUsed: 0, reason: 'no_training_data' });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('groups records by language and applies the user preference decay to each partition', async () => {
    const old = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    query.mockResolvedValueOnce({ rows: [] }); // no stale records
    query.mockResolvedValueOnce({ rows: [
      { language: 'en', label: 'spam', created_at: old, token_counts: { viagra: 2 }, flag_features: { has_attachment: 1 } },
      { language: 'fr', label: 'ham', created_at: old, token_counts: { reunion: 2 }, flag_features: {} },
      { language: 'en', label: 'ham', created_at: NOW, token_counts: { meeting: 1 }, flag_features: {} },
    ] });
    query.mockResolvedValueOnce({ rows: [{ days: 30 }] });
    await expect(retrainUser(USER_ID)).resolves.toMatchObject({ ok: true, recordsUsed: 3 });
    expect(withTransaction).toHaveBeenCalledTimes(1);
    const replacement = query.mock.calls[3][1];
    expect(replacement).toEqual([USER_ID, ['en', 'fr']]);
    const [, en] = query.mock.calls[4];
    const [, fr] = query.mock.calls[5];
    expect(en.slice(0, 2)).toEqual([USER_ID, 'en']);
    expect(fr.slice(0, 2)).toEqual([USER_ID, 'fr']);
    expect(JSON.parse(en[2])).toEqual({ viagra: { spam: 1, ham: 0 }, meeting: { spam: 0, ham: 1 }, __has_attachment__: { spam: 0.5, ham: 0 } });
    expect(JSON.parse(fr[2])).toEqual({ reunion: { spam: 0, ham: 1 } });
    expect(en[7]).toBe(2);
    expect(fr[7]).toBe(1);
  });

  it('re-tokenizes a stale record in its language before rebuilding the partition', async () => {
    const stale = { id: 'record-1', language: 'zh', subject: '网上药店特价销售', body_text: '', body_html: '' };
    const counts = countTokens(tokenize({ subject: stale.subject, body: '', bodyHtml: '' }, 'zh'));
    query.mockResolvedValueOnce({ rows: [stale] });
    query.mockResolvedValueOnce({ rows: [] }); // re-tokenized update
    query.mockResolvedValueOnce({ rows: [] }); // next stale batch empty
    query.mockResolvedValueOnce({ rows: [{ language: 'zh', label: 'spam', created_at: NOW, token_counts: counts, flag_features: {} }] });
    query.mockResolvedValueOnce({ rows: [] }); // default decay
    await expect(retrainUser(USER_ID)).resolves.toMatchObject({ ok: true, recordsUsed: 1 });
    expect(query.mock.calls[1][1]).toEqual([TOKENIZER_VERSION, [stale.id], ['zh'], [JSON.stringify(counts)]]);
    expect(counts).toHaveProperty('药店');
    const params = query.mock.calls[6][1];
    expect(params.slice(0, 2)).toEqual([USER_ID, 'zh']);
    expect(JSON.parse(params[2]).药店.spam).toBe(counts.药店);
  });
});

describe('getAllUsersWithTraining / getAllUsersWithTrainingLog', () => {
  it('returns user ids from spam_models', async () => {
    query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
    await expect(getAllUsersWithTraining()).resolves.toEqual(['a', 'b']);
  });

  it('returns user ids from spam_training_log', async () => {
    query.mockResolvedValueOnce({ rows: [{ user_id: 'c' }] });
    await expect(getAllUsersWithTrainingLog()).resolves.toEqual(['c']);
  });
});
