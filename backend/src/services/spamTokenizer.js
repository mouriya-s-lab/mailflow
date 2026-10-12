// Tokenizer and feature extractor for the antispam classifier.
//
// Pure functions: no I/O, no DB. Converts an email into the bag-of-words
// token list plus the binary/continuous flag features consumed by the
// Multinomial Naive Bayes model (spamModel.js) and persisted at mark time
// (spam_training_log.token_counts / flag_features, migration 0048).
//
// Tokens depend on the message's language (the per-language model partitions of
// mouriya-s-lab/mailflow#15): Chinese and Japanese text is cut into words with
// Intl.Segmenter, every other language into runs of letters and digits, and each
// language drops only its own stop words.
//
// Design reference: .hermes/design/spam-classifier-v0.2.md §6.1

import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { parseAuthResults } from './spamParser.js';
import { STOP_WORDS, STOP_WORDS_DEFAULT } from './stopWords.js';
import { BLOCK, attachmentsWithContained } from './attachmentExtensions.js';

// Attachments are judged by the tiers in attachmentExtensions.js, shared with the download warning.
// The flag feature attachment_is_executable means the BLOCK tier: files that run code when opened.
// Macro Office and HTML files (WARN) score through their own, lighter rule in spamRules.js (#457).

// The version of the token stream below. A training record stores the version its
// token_counts were made with; a retrain re-tokenizes every record of another version.
// Bump it whenever a change here changes the tokens of some message.
export const TOKENIZER_VERSION = 2;

// Each language's own stop words. A message whose language could not be
// determined ('und', 'und-Latn', …) uses the default list stopWords.js keeps for
// that case; a determined language without a list drops none.
const STOP_WORDS_BY_LANGUAGE = new Map([
  ['en', STOP_WORDS.en],
  ['it', STOP_WORDS.it],
  ['de', STOP_WORDS.de],
  ['es', STOP_WORDS.es],
  ['fr', STOP_WORDS.fr],
  ['ru', STOP_WORDS.ru],
  ['zh', STOP_WORDS.zhCN],
]);

// Chinese and Japanese are written without spaces between words, so their text is
// segmented with the ICU word breaker; Korean separates words with spaces like the
// languages WORD_RE handles.
const SEGMENTED_LANGUAGES = new Set(['zh', 'ja']);
const segmenters = new Map();

// Word-ish run: Unicode letters + digits + underscore. Unlike \w, \p{L}
// covers Cyrillic and other non-ASCII scripts (i18n requirement).
const WORD_RE = /[\p{L}\p{N}_]+/gu;

// One Han ideograph is a word in Chinese and Japanese; a lone kana is a particle.
const SINGLE_HAN_RE = /^\p{sc=Han}$/u;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

const MIN_TOKEN_LENGTH = 2;
const MAX_TOKEN_LENGTH = 30;

// Hard caps on the work a single message can cause. The ingest hook is
// fire-and-forget, so without these a pathological message (multi-MB body,
// huge HTML, or a single never-ending word run) would do unbounded synchronous
// work in the tokenizer — and the same caps apply on the training path, so the
// features stored at mark time (Solution C) match what inference sees.
//
// MAX_BODY_CHARS is applied to the RAW field before HTML parsing (the parser
// itself is the expensive step); MAX_TOKENS bounds the token stream. Subject
// tokens are pushed first, so they always survive the token cap.
export const MAX_BODY_CHARS = 64_000;
export const MAX_TOKENS = 2_000;

function capChars(value) {
  if (typeof value !== 'string') return '';
  return value.length > MAX_BODY_CHARS ? value.slice(0, MAX_BODY_CHARS) : value;
}

/**
 * Strip HTML to visible text using htmlparser2 (already a backend
 * dependency). Script/style/head contents are dropped.
 *
 * @param {string} html
 * @returns {string} visible text, whitespace-collapsed
 */
export function cleanText(rawBody) {
  if (!rawBody) return '';
  // Fast path: no HTML tags at all.
  if (!/<[a-z/!]/i.test(rawBody)) {
    return collapseWhitespace(decodeEntities(rawBody));
  }
  // Lazy-load the streaming parser only when needed.
  const parts = [];
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (SKIP_TAGS.has(name.toLowerCase())) skipDepth += 1;
    },
    onclosetag(name) {
      if (SKIP_TAGS.has(name.toLowerCase()) && skipDepth > 0) skipDepth -= 1;
    },
    ontext(text) {
      if (skipDepth === 0) parts.push(text);
    },
  }, { decodeEntities: true });
  parser.write(rawBody);
  parser.end();
  return collapseWhitespace(parts.join(' '));
}

const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript', 'template']);

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeEntities(text) {
  // Covers the common cases; htmlparser2 handles the rest on the HTML path.
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Tokenize an email into a bag-of-words array.
 *
 * @param {Object} message
 *   { subject: string, body: string (plain), bodyHtml?: string }
 *   Subject tokens are weighted ~x1.5 by duplication (subject is the most
 *   discriminative field; the design doc's "x1.5 via duplicazione" is
 *   implemented as subject appearing twice in the token stream).
 * @param {string} language — BCP 47 tag of the message's model partition; its
 *   primary subtag picks the word segmentation and the stop words.
 * @returns {string[]} tokens (lowercase, stop-word-free, length-capped).
 *   Input is capped at MAX_BODY_CHARS per field (before HTML parsing) and the
 *   output at MAX_TOKENS tokens — see the constants above.
 */
export function tokenize(message, language) {
  const primary = primaryLanguage(language);
  const subject = cleanText(capChars(message?.subject));
  const rawBody = message?.body || message?.bodyHtml || '';
  const body = rawBody ? cleanText(capChars(rawBody)) : '';

  const tokens = [];
  // Subject weighted x2 (equivalent to the x1.5 duplication in the design;
  // discrete tokens cannot encode 1.5x, so subject appears twice).
  pushWords(tokens, `${subject} ${subject}`, primary);
  pushWords(tokens, body, primary);

  // URL-host tokens: the host of any URL in the body is a token itself
  // (e.g. bit.ly, tinyurl.com), independent of the words around it.
  for (const url of body.match(URL_RE) || []) {
    const host = extractUrlHost(url);
    if (host) tokens.push(normalizeToken(host, primary));
  }

  return tokens.filter(Boolean).slice(0, MAX_TOKENS);
}

/** A token list as {token: count}, the shape spam_training_log.token_counts stores. */
export function countTokens(tokens) {
  const counts = {};
  for (const token of tokens) counts[token] = (counts[token] || 0) + 1;
  return counts;
}

function primaryLanguage(language) {
  if (typeof language !== 'string' || language === '') {
    throw new TypeError(`tokenize needs a language tag, got ${language}`);
  }
  return language.split('-')[0].toLowerCase();
}

const NO_STOP_WORDS = new Set();

function stopWordsFor(primary) {
  if (primary === 'und') return STOP_WORDS_DEFAULT;
  return STOP_WORDS_BY_LANGUAGE.get(primary) ?? NO_STOP_WORDS;
}

function segmenterFor(primary) {
  let segmenter = segmenters.get(primary);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(primary, { granularity: 'word' });
    segmenters.set(primary, segmenter);
  }
  return segmenter;
}

function words(text, primary) {
  if (!SEGMENTED_LANGUAGES.has(primary)) return text.match(WORD_RE) || [];
  const out = [];
  for (const { segment, isWordLike } of segmenterFor(primary).segment(text)) {
    if (isWordLike) out.push(segment);
  }
  return out;
}

function pushWords(out, text, primary) {
  for (const raw of words(text, primary)) {
    const token = normalizeToken(raw, primary);
    if (token) out.push(token);
  }
}

// Lowercase; enforce length bounds (a single Han ideograph is a word);
// drop the language's stop-words and pure-numeric tokens.
export function normalizeToken(raw, language) {
  const token = raw.toLowerCase();
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    if (!SINGLE_HAN_RE.test(token)) return null;
  }
  if (/^[\p{N}]+$/u.test(token)) return null; // pure numeric
  const primary = primaryLanguage(language);
  if (stopWordsFor(primary).has(token)) return null;
  return token;
}

function extractUrlHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    const m = /^https?:\/\/([^/]+)/i.exec(url);
    return m ? m[1].toLowerCase().replace(/^www\./, '') : null;
  }
}

/**
 * Extract the binary/continuous flag features for a message.
 *
 * @param {Object} message
 *   { subject, from?, replyTo?, headers?, attachments? }
 *   - headers: raw header lines (array) or lowercase-name map (see spamParser)
 *   - attachments: [{ filename?, contentType? }]
 * @param {Object} [opts]
 *   @param {string|Array<string>} [opts.trustedAuthservIds] — authserv-id(s)
 *     whose Authentication-Results headers are honored (see spamParser). With
 *     none, the three auth flags are null: no trusted signal.
 * @returns {Object} flag feature object (schema of spam_training_log.flag_features)
 */
export function extractFlagFeatures(message, opts = {}) {
  const auth = parseAuthResults(message?.headers || [], {
    trustedAuthservIds: opts.trustedAuthservIds,
  });

  // dkim_pass / spf_pass / dmarc_pass: 1 on pass, 0 on fail-like results,
  // null when the header is absent (excluded from scoring, §6.1).
  const authFlags = {};
  for (const method of ['dkim', 'spf', 'dmarc']) {
    const value = auth[method];
    authFlags[`${method}_pass`] = value === null ? null : value === 'pass' ? 1 : 0;
  }

  // Same size cap as tokenize(): the ratio below is scale-invariant, but the
  // subject must not become an unbounded regex input.
  const subject = capChars(message?.subject);
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const judged = attachmentsWithContained(attachments);

  const letters = (subject.match(/\p{L}/gu) || []).length;
  const upper = (subject.match(/\p{Lu}/gu) || []).length;

  const fromDomain = extractEmailDomain(message?.from);
  const replyToDomain = extractEmailDomain(message?.replyTo);

  return {
    ...authFlags,
    has_attachment: attachments.length > 0 ? 1 : 0,
    attachment_is_executable: judged.some(a => {
      const ext = attachmentExtension(a);
      return ext !== null && BLOCK.has(ext);
    }) ? 1 : 0,
    all_caps_subject_ratio: letters > 0 ? upper / letters : 0,
    from_equals_reply_to_mismatch:
      fromDomain && replyToDomain && fromDomain !== replyToDomain ? 1 : 0,
  };
}

// Normalize an email address ("Display Name" <user+tag@Sub.Example.com>)
// down to its lowercase domain, stripping +tags and leading dots.
function extractEmailDomain(address) {
  if (!address) return null;
  const text = String(address);
  // Last <...> wins (RFC 5322 address in angle brackets).
  const angle = /<([^<>]+)>/.exec(text);
  const addr = (angle ? angle[1] : text).trim();
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  const domain = addr.slice(at + 1).toLowerCase();
  return domain || null;
}

function attachmentExtension(attachment) {
  const filename = attachment?.filename || attachment?.name;
  if (filename) {
    const base = String(filename).trim();
    const lastDot = base.lastIndexOf('.');
    if (lastDot > 0 && lastDot < base.length - 1) {
      return base.slice(lastDot + 1).toLowerCase();
    }
  }
  // No usable extension (a part with no name is stored as "attachment"): fall back to a MIME type
  // that can only mean a Windows program. Stored attachments carry it as `type` (walkStructure);
  // reading only `contentType` left this fallback dead (#457). application/vnd.ms-* is not one of
  // them: that prefix covers ordinary Excel, Word and PowerPoint files.
  const ct = attachment?.type || attachment?.contentType || '';
  return /^\s*application\/(x-)?(exe|msdownload|msdos-program|dosexec|ms-installer)\b/i.test(ct)
    ? 'exe' : null;
}

/**
 * Stable fingerprint of a message's tokens + flags, used to dedupe
 * re-classification calls (design §11.5).
 *
 * @param {Object} message — same shape as tokenize() + extractFlagFeatures()
 * @param {string} language — as for tokenize()
 * @returns {string} hex sha-256
 */
export function tokenFingerprint(message, language) {
  const tokens = tokenize(message, language);
  const flags = extractFlagFeatures(message);
  const canonical = JSON.stringify({ t: [...tokens].sort(), f: flags });
  return createHash('sha256').update(canonical).digest('hex');
}
