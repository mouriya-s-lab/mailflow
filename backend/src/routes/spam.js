// Antispam admin/status endpoints (v0.2) — V2-7.
//
// Namespace /api/spam/*: status, per-user thresholds, decay threshold,
// retrain-now, per-user master enable, GDPR reset (all accounts), audit
// trail of deletions, and the explain payload for the "Why?" modal.
// Per-account reset lives on /api/accounts/:id/spam/reset-training (design
// §16, GDPR) — exported separately and mounted by index.js.
//
// Design: .hermes/design/spam-classifier-v0.2.md §11.7, §6.3, §16.

import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { tokenize, extractFlagFeatures } from '../services/spamTokenizer.js';
import { scoreRules } from '../services/spamRules.js';
import { classifyMessage, extractTopTokens, maturityOf, MODEL_VERSION } from '../services/spamModel.js';
import {
  getModelsForUser, getModelForUser, invalidateModelCache, partitionLanguage,
  getDecayThresholdDays, setDecayThresholdDays,
} from '../services/spamModelStore.js';
import { getMessageHeaders } from '../../fork-features/headers/index.js';
import { runFullRetrain } from '../services/spamScheduler.js';
import { detectAuthservIds } from '../services/spamAuthservIds.js';

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hardcoded structural thresholds (design §6.3 — not user-configurable).
const DEFAULT_THRESHOLDS = {
  minRecords: 50,
  softRecords: 500,
  hardRecords: 500,
  spamThreshold: 0.85,
  autoMoveThreshold: 0.95,
};

// How long the explain recompute waits for a message's retained headers.
const HEADER_DEADLINE_MS = 10_000;

async function getUserPreferences(userId) {
  const result = await query('SELECT preferences FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.preferences || {};
}

// Read per-user spam thresholds from users.preferences (JSONB), merged over
// defaults. Unknown/missing keys fall back silently.
async function readThresholds(userId) {
  const prefs = await getUserPreferences(userId);
  const stored = prefs.spam_thresholds && typeof prefs.spam_thresholds === 'object'
    ? prefs.spam_thresholds : {};
  return {
    minRecords: stored.minRecords ?? DEFAULT_THRESHOLDS.minRecords,
    softRecords: stored.softRecords ?? DEFAULT_THRESHOLDS.softRecords,
    hardRecords: stored.hardRecords ?? DEFAULT_THRESHOLDS.hardRecords,
    spamThreshold: stored.spamThreshold ?? DEFAULT_THRESHOLDS.spamThreshold,
    autoMoveThreshold: stored.autoMoveThreshold ?? DEFAULT_THRESHOLDS.autoMoveThreshold,
  };
}

async function writeThresholds(userId, patch) {
  await query(
    `UPDATE users
     SET preferences = jsonb_set(
       COALESCE(preferences, '{}'::jsonb),
       '{spam_thresholds}',
       (COALESCE(preferences->'spam_thresholds', '{}'::jsonb) || $2::jsonb)
     )
     WHERE id = $1`,
    [userId, JSON.stringify(patch)],
  );
}

// ── GET /api/spam/status ────────────────────────────────────────────────────
// The user's model partitions, one per language, largest first.
router.get('/status', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const [models, accounts, prefs, decayThresholdDays] = await Promise.all([
      getModelsForUser(userId),
      query('SELECT count(*)::int AS n FROM email_accounts WHERE user_id = $1 AND antispam_enabled = true', [userId]),
      getUserPreferences(userId),
      getDecayThresholdDays(userId),
    ]);
    const enabled = prefs.spamEnabled !== false && accounts.rows[0].n > 0;
    const partitions = [...models]
      .map(([language, model]) => ({
        language,
        trainingRecords: model.trainingRecords,
        maturity: maturityOf(model.trainingRecords),
        lastTrainedAt: model.lastTrainedAt,
      }))
      .sort((a, b) => b.trainingRecords - a.trainingRecords || a.language.localeCompare(b.language));
    res.json({
      enabled,
      masterEnabled: prefs.spamEnabled !== false,
      antispamAccounts: accounts.rows[0].n,
      modelVersion: models.size > 0 ? MODEL_VERSION : null,
      decayThresholdDays,
      partitions,
    });
  } catch (err) { next(err); }
});

// ── GET/PATCH /api/spam/thresholds ─────────────────────────────────────────
router.get('/thresholds', async (req, res, next) => {
  try {
    res.json(await readThresholds(req.session.userId));
  } catch (err) { next(err); }
});

router.patch('/thresholds', requireAdmin, async (req, res, next) => {
  try {
    const { minRecords, softRecords, hardRecords, spamThreshold, autoMoveThreshold } = req.body;
    const patch = {};
    if (minRecords != null) patch.minRecords = minRecords;
    if (softRecords != null) patch.softRecords = softRecords;
    if (hardRecords != null) patch.hardRecords = hardRecords;
    if (spamThreshold !== undefined) {
      if (typeof spamThreshold !== 'number' || spamThreshold < 0.5 || spamThreshold > 0.99) {
        return res.status(400).json({ error: 'spamThreshold must be between 0.5 and 0.99' });
      }
      patch.spamThreshold = spamThreshold;
    }
    if (autoMoveThreshold !== undefined) {
      if (typeof autoMoveThreshold !== 'number' || autoMoveThreshold < 0.7 || autoMoveThreshold > 0.99) {
        return res.status(400).json({ error: 'autoMoveThreshold must be between 0.7 and 0.99' });
      }
      patch.autoMoveThreshold = autoMoveThreshold;
    }
    await writeThresholds(req.session.userId, patch);
    res.json(await readThresholds(req.session.userId));
  } catch (err) { next(err); }
});

// ── GET/PATCH /api/spam/decay-threshold ────────────────────────────────────
router.get('/decay-threshold', async (req, res, next) => {
  try {
    res.json({ decayThresholdDays: await getDecayThresholdDays(req.session.userId) });
  } catch (err) { next(err); }
});

router.patch('/decay-threshold', async (req, res, next) => {
  try {
    const value = req.body?.decayThresholdDays;
    const days = parseInt(value, 10);
    if (!Number.isInteger(days) || days < 7 || days > 365) {
      return res.status(400).json({ error: 'decayThresholdDays must be an integer between 7 and 365' });
    }
    // A per-user setting shared by every language partition; retrainUser reads it.
    await setDecayThresholdDays(req.session.userId, days);
    res.json({ decayThresholdDays: days });
  } catch (err) { next(err); }
});

// ── POST /api/spam/retrain-now (admin) ─────────────────────────────────────
router.post('/retrain-now', requireAdmin, async (req, res, next) => {
  try {
    const result = await runFullRetrain();
    // A run already in flight (the hourly bucket, or another admin request) is
    // refused rather than queued: it would retrain the same users concurrently and
    // write the same model rows twice over. Same 409 the inbox-rules sweep returns
    // for its single-flight guard.
    if (result.ok === false && result.reason === 'already_running') {
      return res.status(409).json({
        error: 'retrain_in_progress',
        runningKind: result.runningKind ?? null,
      });
    }
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ── POST /api/spam/enable (per-user master switch) ─────────────────────────
router.post('/enable', async (req, res, next) => {
  try {
    const enabled = req.body?.enabled === true;
    await query(
      `UPDATE users SET preferences = COALESCE(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [req.session.userId, JSON.stringify({ spamEnabled: enabled })],
    );
    res.json({ enabled });
  } catch (err) { next(err); }
});

// ── POST /api/spam/reset-training-all (GDPR, confirm required) ─────────────
router.post('/reset-training-all', async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'confirmation_required' });
    }
    const userId = req.session.userId;
    const [logRes, modelRes] = await Promise.all([
      query('DELETE FROM spam_training_log WHERE user_id = $1', [userId]),
      query('DELETE FROM spam_models WHERE user_id = $1', [userId]),
    ]);
    await query(
      `INSERT INTO spam_training_deletions (user_id, scope, records_deleted, ip_address, user_agent)
       VALUES ($1, 'all', $2, $3::inet, $4)`,
      [userId, logRes.rowCount, ipOf(req), truncateUserAgent(req)],
    );
    invalidateModelCache(userId);
    const accounts = await query(
      'SELECT count(*)::int AS n, count(*) FILTER (WHERE antispam_enabled)::int AS enabled_n FROM email_accounts WHERE user_id = $1',
      [userId],
    );
    res.json({
      ok: true,
      deletedTrainingRecords: logRes.rowCount,
      deletedModels: modelRes.rowCount,
      affectedAccounts: accounts.rows[0].n,
    });
  } catch (err) { next(err); }
});

// ── GET /api/spam/deletions (audit trail, own rows only) ──────────────────
router.get('/deletions', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT scope, records_deleted, reason, requested_at, account_id
       FROM spam_training_deletions WHERE user_id = $1
       ORDER BY requested_at DESC LIMIT 100`,
      [req.session.userId],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── GET /api/spam/authserv-ids?accountId=… (admin) ──────────────────────────
// Setup helper for the account form's trusted-authserv-id field: the
// Authentication-Results authserv-ids actually observed on this account's
// recently classified mail, most frequent first. Nothing is trusted
// automatically — the admin picks a value (and can see how dominant it is).
router.get('/authserv-ids', requireAdmin, async (req, res, next) => {
  try {
    const { accountId } = req.query;
    if (!accountId || !UUID_RE.test(accountId)) {
      return res.status(400).json({ error: 'Invalid accountId' });
    }
    const owned = await query(
      'SELECT id, trusted_authserv_id FROM email_accounts WHERE id = $1 AND user_id = $2',
      [accountId, req.session.userId],
    );
    if (!owned.rows.length) return res.status(404).json({ error: 'Account not found' });

    const { analyzed, detected } = await detectAuthservIds(accountId);
    res.json({
      accountId,
      trustedAuthservId: owned.rows[0].trusted_authserv_id ?? null,
      analyzed,
      detected,
    });
  } catch (err) { next(err); }
});

// ── GET /api/spam/explain?messageId=… (for the "Why?" modal) ───────────────
router.get('/explain', async (req, res, next) => {
  try {
    const { messageId } = req.query;
    if (!messageId || !UUID_RE.test(messageId)) {
      return res.status(400).json({ error: 'Invalid messageId' });
    }
    const data = await query(
      `SELECT m.*, a.user_id AS owner_id, a.folder_mappings
       FROM messages m JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = $1 AND a.user_id = $2`,
      [messageId, req.session.userId],
    );
    const row = data.rows[0];
    if (!row) return res.status(404).json({ error: 'Message not found' });

    const storedDetails = typeof row.spam_details === 'string'
      ? JSON.parse(row.spam_details)
      : (row.spam_details ?? null);

    // Replay what the verdict saw (#457). Recomputing against the row as it is now drifted from
    // the verdict: attachments and bodies fill in after ingest, and the recompute had none of the
    // headers the auth rules read. spamPipeline records every input below with each verdict,
    // the model partition included (a verdict from before partitions has none).
    if (storedDetails?.rulesFired) {
      const used = storedDetails.partition;
      return res.json({
        verdict: row.spam_verdict,
        storedScore: row.spam_score_ml ?? null,
        method: storedDetails.method || 'rules',
        confidence: storedDetails.mlConfidence ?? storedDetails.rulesScore ?? null,
        rulesFired: storedDetails.rulesFired,
        rulesScore: storedDetails.rulesScore ?? null,
        mlProbability: storedDetails.mlProbability ?? null,
        mlTopTokens: storedDetails.topTokens || [],
        partition: used
          ? { language: used.language, trainingRecords: used.trainingRecords, maturity: maturityOf(used.trainingRecords) }
          : null,
        replayed: true,
        storedDetails,
      });
    }

    // No recorded inputs (a verdict from before they were stored, or none yet): recompute, as
    // before, with the partition the message would be classified in now.
    const msg = {
      subject: row.subject || '',
      body: row.body_text || '',
      bodyHtml: row.body_html || '',
      from: row.from_email ? `<${row.from_email}>` : null,
      replyTo: null,
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      headers: [],
    };
    const headers = (await getMessageHeaders([row.id], { deadlineMs: HEADER_DEADLINE_MS })).get(row.id);
    const language = partitionLanguage({
      subject: row.subject,
      contentLanguage: headers?.kind === 'stored' ? headers.headers['content-language'] ?? null : null,
    });
    const tokens = tokenize(msg, language);
    const flagFeatures = extractFlagFeatures(msg);

    const rules = scoreRules(msg, { userContacts: new Set() });
    const model = await getModelForUser(row.owner_id, language);
    const trainingRecords = model?.trainingRecords ?? 0;
    const mlActive = trainingRecords >= 50;
    let mlResult = null;
    if (mlActive) mlResult = classifyMessage(model, tokens, flagFeatures);

    res.json({
      verdict: row.spam_verdict,
      storedScore: row.spam_score_ml ?? null,
      method: mlActive ? 'blended' : 'rules',
      confidence: mlResult?.confidence ?? rules.score,
      rulesFired: rules.fired.map(r => ({ name: r.name, weight: r.weight })),
      rulesScore: rules.score,
      mlProbability: mlResult?.probability ?? null,
      mlTopTokens: extractTopTokens(model, tokens, 5, flagFeatures).map(t => ({
        token: t.token, contribution: Math.round(t.contribution * 1000) / 1000,
      })),
      partition: { language, trainingRecords, maturity: maturityOf(trainingRecords) },
      replayed: false,
      storedDetails,
    });
  } catch (err) { next(err); }
});

// ── Per-account reset (mounted separately at /api/accounts) ────────────────
// POST /api/accounts/:id/spam/reset-training — scope per-account (§16).
export const accountSpamRouter = Router();
accountSpamRouter.use(requireAuth);

accountSpamRouter.post('/:id/spam/reset-training', async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'confirmation_required' });
    }
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid account id' });
    const userId = req.session.userId;

    // Ownership check.
    const owned = await query(
      'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (!owned.rows.length) return res.status(404).json({ error: 'Account not found' });

    const logRes = await query(
      'DELETE FROM spam_training_log WHERE user_id = $1 AND account_id = $2',
      [userId, id],
    );
    // The models are per user (one per language), not per account: this reset clears all of
    // the user's partitions (documented in the UI) rather than keeping half-trained models.
    const modelRes = await query('DELETE FROM spam_models WHERE user_id = $1', [userId]);
    await query(
      `INSERT INTO spam_training_deletions (user_id, account_id, scope, records_deleted, ip_address, user_agent)
       VALUES ($1, $2, 'per_account', $3, $4::inet, $5)`,
      [userId, id, logRes.rowCount, ipOf(req), truncateUserAgent(req)],
    );
    invalidateModelCache(userId);

    res.json({
      ok: true,
      deletedTrainingRecords: logRes.rowCount,
      deletedModel: modelRes.rowCount > 0,
    });
  } catch (err) { next(err); }
});

function ipOf(req) {
  const ip = req.ip || req.socket?.remoteAddress;
  if (!ip) return null;
  // ::ffff:1.2.3.4 → 1.2.3.4
  const plain = ip.replace(/^::ffff:/, '');
  if (plain === '::1' || plain === '127.0.0.1') return '127.0.0.1';
  return ip;
}

function truncateUserAgent(req) {
  const ua = req.headers?.['user-agent'] || '';
  return ua.slice(0, 300) || null;
}

export default router;