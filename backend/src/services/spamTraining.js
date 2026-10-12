// Anti-spam training records (fork, mouriya-s-lab/mailflow#14).
//
// The only code that writes spam_training_log. Every write takes a messages row id and loads
// what it needs from that row, so callers never build features themselves and a richer
// feature extraction changes this module alone.
//
// Two sources write here: an explicit user mark ('manual', from POST /spam and /ham, also fed
// to the incremental model) and Jev's external cold-start verdicts ('jev', no incremental
// training; they reach the model at the next retrain). Automatic verdicts of the anti-spam
// pipeline itself never do.

import { query } from './db.js';
import { logger } from './logger.js';
import { getMessageHeaders } from '../../fork-features/headers/index.js';
import { tokenize, countTokens, extractFlagFeatures, TOKENIZER_VERSION } from './spamTokenizer.js';
import { updateIncrementalForUser, retrainUser, partitionLanguage } from './spamModelStore.js';

const LABELS = new Set(['spam', 'ham']);

// How long a mark waits for the retained headers of a message (fetched from IMAP when the
// message predates header retention). Only Content-Language is read from them.
const HEADER_DEADLINE_MS = 10_000;

function assertLabel(label) {
  if (!LABELS.has(label)) throw new TypeError(`spam training label must be 'spam' or 'ham', got ${label}`);
}

// The messages row a training record is built from, with its owner.
async function loadMessage(messageId) {
  const { rows } = await query(
    `SELECT m.*, a.user_id AS owner_id
     FROM messages m JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1`,
    [messageId],
  );
  return rows[0] ?? null;
}

// The message's model partition, from its subject and retained Content-Language header —
// the inputs classification has at ingest. Headers that cannot be read (the header store
// has logged why) leave the language undeclared.
async function messageLanguage(message) {
  const headers = (await getMessageHeaders([message.id], { deadlineMs: HEADER_DEADLINE_MS })).get(message.id);
  const contentLanguage = headers?.kind === 'stored' ? headers.headers['content-language'] ?? null : null;
  return partitionLanguage({ subject: message.subject, contentLanguage });
}

// The feature payload for a messages row. Shape matches spam_training_log (migrations 0052,
// 9004) + spamModelStore inputs.
function extractSpamFeatures(message, language) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const attachmentNames = attachments
    .map(a => a?.filename || a?.name)
    .filter(Boolean)
    .map(f => { const dot = String(f).lastIndexOf('.'); return dot > 0 ? String(f).slice(dot + 1).toLowerCase() : null; })
    .filter(Boolean);

  const msg = {
    subject: message.subject || '',
    body: message.body_text || '',
    bodyHtml: message.body_html || '',
    from: message.from_email ? `<${message.from_email}>` : null,
    replyTo: null,
    headers: [],
    attachments,
  };
  const tokens = tokenize(msg, language);

  return {
    subject: msg.subject,
    body_text: message.body_text || null,
    body_html: message.body_html || null,
    language,
    tokens,
    token_counts: countTokens(tokens),
    flag_features: extractFlagFeatures(msg),
    sender_domain: message.from_email ? message.from_email.split('@').pop()?.toLowerCase() || null : null,
    attachment_types: attachmentNames.length ? attachmentNames : null,
  };
}

function recordParams(userId, message, placement, label, features) {
  return [
    userId, message.account_id, message.message_id || null, placement.uid, placement.folder, label,
    features.subject, features.body_text, features.body_html,
    JSON.stringify(features.token_counts), JSON.stringify(features.flag_features),
    features.sender_domain, features.attachment_types ?? null,
    features.language, TOKENIZER_VERSION,
  ];
}

/**
 * Capture a user's spam/ham mark of a message, before the message is moved. The features
 * are taken from the row as it is now; `record({ uid, folder })`, called once the message
 * sits in its destination folder, writes the training record with that placement and feeds
 * the model of the message's language partition incrementally. A row deleted during the move
 * still gets its record.
 *
 * @returns {Promise<{ kind: 'captured', record: (placement: { uid: number, folder: string }) => Promise<void> }
 *                   | { kind: 'message_missing' }>}
 */
export async function captureManualSpamLabel({ userId, messageId, label }) {
  assertLabel(label);
  const message = await loadMessage(messageId);
  if (!message || message.owner_id !== userId) return { kind: 'message_missing' };
  const features = extractSpamFeatures(message, await messageLanguage(message));

  const record = async placement => {
    await query(
      `INSERT INTO spam_training_log
         (user_id, account_id, message_id_header, message_uid, folder, label, source,
          subject, body_text, body_html, token_counts, flag_features, sender_domain, attachment_types,
          language, tokenizer_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT DO NOTHING`,
      recordParams(userId, message, placement, label, features),
    );
    // Incremental training: update the partition's Naive Bayes model in <1s.
    // Non-blocking on failure — user feedback must never break the HTTP path.
    try {
      await updateIncrementalForUser(userId, features.language, features.tokens, features.flag_features, label);
    } catch (err) {
      console.warn(`spam incremental training failed for user ${userId}:`, err.message);
    }
  };
  return { kind: 'captured', record };
}

/**
 * Record a Jev spam/ham verdict for a message as a training record of source 'jev'. One record
 * per message per account (spam_training_log_jev_message_uniq); a message without a
 * Message-ID cannot be told apart from others and is not recorded. No incremental training:
 * the record reaches the model at the user's next retrain.
 *
 * @returns {Promise<{ kind: 'recorded' } | { kind: 'duplicate' } | { kind: 'no_message_id' }
 *                   | { kind: 'message_missing' }>}
 */
export async function recordJevSpamVerdict({ messageId, label }) {
  assertLabel(label);
  const message = await loadMessage(messageId);
  if (!message) return { kind: 'message_missing' };
  if (!message.message_id) return { kind: 'no_message_id' };
  const features = extractSpamFeatures(message, await messageLanguage(message));

  const { rows } = await query(
    `INSERT INTO spam_training_log
       (user_id, account_id, message_id_header, message_uid, folder, label, source,
        subject, body_text, body_html, token_counts, flag_features, sender_domain, attachment_types,
        language, tokenizer_version)
     VALUES ($1, $2, $3, $4, $5, $6, 'jev', $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (user_id, account_id, message_id_header)
       WHERE source = 'jev' AND message_id_header IS NOT NULL
       DO NOTHING
     RETURNING id`,
    recordParams(message.owner_id, message, message, label, features),
  );
  return rows.length ? { kind: 'recorded' } : { kind: 'duplicate' };
}

// Retrains in progress, by user id. An entry is added synchronously when a retrain starts and
// removed when it settles.
const retrainsInFlight = new Set();

/**
 * Rebuild a user's model from their training records now. One retrain per user at a time: a
 * request while one is running is refused, not queued, since the running one reads the same
 * records.
 *
 * @returns {Promise<{ kind: 'retrained', records: number } | { kind: 'already_running' }
 *                   | { kind: 'no_training_data' } | { kind: 'failed', reason: string }>}
 */
export async function requestSpamRetrain(userId) {
  if (retrainsInFlight.has(userId)) return { kind: 'already_running' };
  retrainsInFlight.add(userId);
  try {
    const result = await retrainUser(userId);
    if (result.ok) return { kind: 'retrained', records: result.recordsUsed };
    if (result.reason === 'no_training_data') return { kind: 'no_training_data' };
    throw new Error(`retrainUser returned an unknown reason: ${result.reason}`);
  } catch (err) {
    logger.warn(`[spam] retrain failed for user ${userId}: ${err.message}`);
    return { kind: 'failed', reason: err.message };
  } finally {
    retrainsInFlight.delete(userId);
  }
}
