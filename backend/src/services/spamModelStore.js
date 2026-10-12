// spam_models DB access + in-memory cache (v0.2) — V2-4.
//
// Separates DB I/O from the pure math in spamModel.js. A user has one model per
// language partition (mouriya-s-lab/mailflow#15): one spam_models row per
// (user_id, language). Reads go through a per-user 5-minute in-memory cache of all
// of a user's partitions (same pattern as categorizer.js's socialDomainCache);
// writes (POST /spam, /ham) update one partition row and invalidate the user's
// cache entry so user feedback is reflected in <1s.
//
// Retrains (scheduled / admin) rebuild every partition of a user from
// spam_training_log via spamModel.retrainFromRecords() and invalidate the cache.

import { query, withTransaction } from './db.js';
import { resolveLanguage } from '../../fork-features/signals/index.js';
import { tokenize, countTokens, TOKENIZER_VERSION } from './spamTokenizer.js';
import {
  createEmptyModel,
  updateIncremental,
  retrainFromRecords,
  pruneVocabulary,
  MODEL_VERSION,
} from './spamModel.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const modelCache = new Map(); // userId -> { partitions: Map<language, model>, expiry }

export const DEFAULT_DECAY_DAYS = 90;

// Old training records are re-tokenized this many at a time during a retrain.
const RETOKENIZE_BATCH = 200;

export function invalidateModelCache(userId) {
  modelCache.delete(userId);
}

/**
 * The model partition of a message: the language the message signals resolve from
 * its subject and Content-Language header. The body is left out on purpose: new
 * mail is classified at ingest before its body is fetched, so a language read from
 * the body when the message is marked later would put its training record in
 * another partition than the one it was classified with.
 *
 * @param {{ subject: string|null, contentLanguage: string|null }} message
 * @returns {string} BCP 47 tag
 */
export function partitionLanguage({ subject, contentLanguage }) {
  return resolveLanguage({ subject, bodyText: null, bodyHtml: null, contentLanguage }).resolved;
}

// Map a DB row to the in-memory model shape.
function rowToModel(row) {
  return {
    vocabulary: row.vocabulary || {},
    totalSpam: Number(row.total_spam) || 0,
    totalHam: Number(row.total_ham) || 0,
    priorSpam: Number(row.prior_spam),
    priorHam: Number(row.prior_ham),
    trainingRecords: Number(row.training_records) || 0,
    modelVersion: Number(row.model_version) || MODEL_VERSION,
    lastTrainedAt: row.last_trained_at ?? null,
  };
}

/**
 * All of a user's model partitions, cached, DB read on miss. An empty Map when the
 * user has none yet (cold start).
 *
 * @returns {Promise<Map<string, Object>>} language -> model
 */
export async function getModelsForUser(userId) {
  const cached = modelCache.get(userId);
  if (cached && cached.expiry > Date.now()) return cached.partitions;

  const result = await query('SELECT * FROM spam_models WHERE user_id = $1', [userId]);
  const partitions = new Map(result.rows.map(row => [row.language, rowToModel(row)]));
  modelCache.set(userId, { partitions, expiry: Date.now() + CACHE_TTL_MS });
  return partitions;
}

/** The user's model of one language partition, or null when it has none. */
export async function getModelForUser(userId, language) {
  return (await getModelsForUser(userId)).get(language) ?? null;
}

const UPSERT_MODEL = `INSERT INTO spam_models
     (user_id, language, vocabulary, total_spam, total_ham, prior_spam, prior_ham,
      training_records, model_version, last_trained_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
   ON CONFLICT (user_id, language) DO UPDATE SET
     vocabulary = EXCLUDED.vocabulary,
     total_spam = EXCLUDED.total_spam,
     total_ham = EXCLUDED.total_ham,
     prior_spam = EXCLUDED.prior_spam,
     prior_ham = EXCLUDED.prior_ham,
     training_records = EXCLUDED.training_records,
     model_version = EXCLUDED.model_version,
     last_trained_at = EXCLUDED.last_trained_at,
     updated_at = NOW()`;

/** Map the in-memory model shape to the DB columns. */
function modelToParams(userId, language, model) {
  return [
    userId,
    language,
    JSON.stringify(model.vocabulary),
    model.totalSpam,
    model.totalHam,
    model.priorSpam,
    model.priorHam,
    model.trainingRecords,
    model.modelVersion ?? MODEL_VERSION,
    model.lastTrainedAt ?? new Date().toISOString(),
  ];
}

/** UPSERT one partition row, then invalidate the user's cache entry. */
export async function saveModel(userId, language, model) {
  await query(UPSERT_MODEL, modelToParams(userId, language, model));
  invalidateModelCache(userId);
}

/**
 * Incrementally train one partition on one user feedback event (POST /spam or
 * /ham), with the tokens the training record stores. No-op on labels other than
 * 'spam'/'ham'.
 *
 * @param {string} userId
 * @param {string} language — the record's partition
 * @param {string[]} tokens — spamTokenizer.tokenize() output for that language
 * @param {Object} flagFeatures — spamTokenizer.extractFlagFeatures() output
 * @param {'spam'|'ham'} label
 * @returns {Object} the updated model
 */
export async function updateIncrementalForUser(userId, language, tokens, flagFeatures, label) {
  if (label !== 'spam' && label !== 'ham') return null; // no-op on invalid labels
  const model = (await getModelForUser(userId, language)) || createEmptyModel();
  const updated = updateIncremental(model, tokens, flagFeatures, label);
  await saveModel(userId, language, updated);
  return updated;
}

/**
 * The user's decay window for the full retrain (users.preferences, migration 9004).
 * It is a per-user setting, shared by all of the user's partitions.
 */
export async function getDecayThresholdDays(userId) {
  const result = await query(
    `SELECT preferences->'spamDecayThresholdDays' AS days FROM users WHERE id = $1`,
    [userId],
  );
  const days = result.rows[0]?.days;
  return Number.isInteger(days) ? days : DEFAULT_DECAY_DAYS;
}

/** Store the user's decay window; the caller validates the 7–365 range. */
export async function setDecayThresholdDays(userId, days) {
  await query(
    `UPDATE users SET preferences = COALESCE(preferences, '{}'::jsonb) || jsonb_build_object('spamDecayThresholdDays', $2::int)
     WHERE id = $1`,
    [userId, days],
  );
}

/** All user IDs that have any row in spam_models (retrained already). */
export async function getAllUsersWithTraining() {
  const result = await query('SELECT DISTINCT user_id FROM spam_models');
  return result.rows.map(r => r.user_id);
}

/** All user IDs with at least one training-log record (candidates for retrain). */
export async function getAllUsersWithTrainingLog() {
  const result = await query('SELECT DISTINCT user_id FROM spam_training_log');
  return result.rows.map(r => r.user_id);
}

/**
 * Bring every training record of a user to the current tokenizer: a record written
 * before its language was stored gets it from its stored subject (its
 * Content-Language was never stored, so it counts as undeclared; no subject gives
 * 'und'), and its token_counts are made again from its stored subject and body.
 * Each batch is written back before the next is read.
 *
 * @returns {Promise<number>} records rewritten
 */
async function retokenizeRecords(userId) {
  let rewritten = 0;
  let after = null;
  for (;;) {
    const { rows } = await query(
      `SELECT id, language, subject, body_text, body_html
       FROM spam_training_log
       WHERE user_id = $1 AND tokenizer_version IS DISTINCT FROM $2
         AND ($3::uuid IS NULL OR id > $3::uuid)
       ORDER BY id
       LIMIT $4`,
      [userId, TOKENIZER_VERSION, after, RETOKENIZE_BATCH],
    );
    if (rows.length === 0) return rewritten;

    const languages = rows.map(r => r.language ?? partitionLanguage({ subject: r.subject, contentLanguage: null }));
    const counts = rows.map((r, i) => JSON.stringify(countTokens(tokenize({
      subject: r.subject || '',
      body: r.body_text || '',
      bodyHtml: r.body_html || '',
    }, languages[i]))));
    await query(
      `UPDATE spam_training_log t
       SET language = u.language, token_counts = u.token_counts, tokenizer_version = $1
       FROM unnest($2::uuid[], $3::text[], $4::jsonb[]) AS u(id, language, token_counts)
       WHERE t.id = u.id`,
      [TOKENIZER_VERSION, rows.map(r => r.id), languages, counts],
    );
    rewritten += rows.length;
    after = rows[rows.length - 1].id;
  }
}

/**
 * Full retrain of one user from spam_training_log (NO JOIN; features are
 * stored at mark time — migration 0048). Records of an older tokenizer are
 * re-tokenized first (see retokenizeRecords). Each language partition is then
 * built from its own records with the user's exponential decay and pruned via
 * spamModel.pruneVocabulary; the user's partitions are replaced in one
 * transaction (a partition left without records is removed) and the cache is
 * invalidated.
 *
 * A Jev record of a message the user also marked by hand in the same account
 * is left out: the user's own mark wins over the external verdict.
 *
 * @param {string} userId
 * @returns {{ ok: boolean, recordsUsed: number, duration_ms: number, reason?: string }}
 */
export async function retrainUser(userId) {
  const started = Date.now();
  await retokenizeRecords(userId);

  const data = await query(
    `SELECT t.language, t.label, t.created_at, t.token_counts, t.flag_features
     FROM spam_training_log t
     WHERE t.user_id = $1
       AND NOT (t.source = 'jev' AND EXISTS (
         SELECT 1 FROM spam_training_log m
         WHERE m.user_id = t.user_id AND m.account_id = t.account_id
           AND m.message_id_header = t.message_id_header AND m.source = 'manual'))`,
    [userId],
  );
  const records = data.rows;
  if (records.length === 0) {
    return { ok: false, recordsUsed: 0, duration_ms: Date.now() - started, reason: 'no_training_data' };
  }

  const byLanguage = new Map();
  for (const record of records) {
    const partition = byLanguage.get(record.language);
    if (partition) partition.push(record);
    else byLanguage.set(record.language, [record]);
  }

  const decayThresholdDays = await getDecayThresholdDays(userId);
  const models = [...byLanguage].map(([language, partitionRecords]) => {
    const model = retrainFromRecords(partitionRecords, decayThresholdDays);
    // Keep each partition bounded in case its raw vocabulary grew large (design §14).
    return [language, Object.keys(model.vocabulary).length > 10000 ? pruneVocabulary(model, 10000) : model];
  });

  await withTransaction(async client => {
    await client.query(
      'DELETE FROM spam_models WHERE user_id = $1 AND NOT (language = ANY($2::text[]))',
      [userId, models.map(([language]) => language)],
    );
    for (const [language, model] of models) {
      await client.query(UPSERT_MODEL, modelToParams(userId, language, model));
    }
  });
  invalidateModelCache(userId);
  return { ok: true, recordsUsed: records.length, duration_ms: Date.now() - started };
}
