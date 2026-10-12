// Message signals (K5, mouriya-s-lab/mailflow#11).
//
// One structured view of a stored message for the anti-spam pipeline, training and the Jev state:
// who sent it and to how many, whether a trusted receiving server authenticated it, where its
// links go against what they show, its attachments, mailing-list marks and its language. Built
// from the messages row and the headers kept by fork-features/headers (K4); nothing here talks to
// the network or writes anything.

import { Parser } from 'htmlparser2';
import { query } from '../../src/services/db.js';
import { extractAuthservIds, normalizeAuthservId, parseAuthResults } from '../../src/services/spamParser.js';
import { STOP_WORDS } from '../../src/services/stopWords.js';
import { hostOfUrl, registrableDomain } from '../domains/index.js';
import { getMessageHeaders } from '../headers/index.js';

const MAX_LINKS = 50;
const MAX_LINK_TEXT = 200;
const MAX_LANGUAGE_LETTERS = 4000;
const KANA_SHARE_FOR_JA = 0.1;
const STOP_WORD_MIN_HITS = 3;
const STOP_WORD_LEAD = 1.5;
const STOP_WORD_LANGUAGES = ['en', 'it', 'de', 'es', 'fr', 'ru'];

// ISO 15924 codes. Kana is one bucket (Hrkt): the prolonged sound mark is Script=Common, so it is
// listed explicitly. A letter in any other script counts as Zzzz.
const SCRIPTS = [
  ['Hrkt', /[\p{sc=Hiragana}\p{sc=Katakana}\u30FC\uFF70]/u],
  ['Hani', /\p{sc=Han}/u],
  ['Hang', /\p{sc=Hangul}/u],
  ['Latn', /\p{sc=Latin}/u],
  ['Cyrl', /\p{sc=Cyrillic}/u],
  ['Grek', /\p{sc=Greek}/u],
  ['Hebr', /\p{sc=Hebrew}/u],
  ['Arab', /\p{sc=Arabic}/u],
  ['Thai', /\p{sc=Thai}/u],
];
const OTHER_SCRIPT = 'Zzzz';
const LETTER = /\p{L}/u;
const STRONG_SCRIPT_LANGUAGE = { Hang: 'ko', Thai: 'th', Grek: 'el', Hebr: 'he', Arab: 'ar' };
const HAN_DECLARABLE = new Set(['ja', 'zh', 'ko']);

// Anchor text that is itself a URL or a bare host name: an optional http(s) scheme, dotted labels
// ending in a letter label (or punycode), an optional port and path. "点击这里" or "Sign in" is not.
const URL_LIKE_TEXT = /^(?:https?:\/\/)?(?:[\p{L}\p{N}-]+\.)+(?:\p{L}{2,}|xn--[a-z0-9-]+)\.?(?::\d+)?(?:[/?#]\S*)?$/iu;

// One pass over the stored HTML: anchors in document order, the <html> lang, the first lang on
// any element, and the visible text (script and style excluded).
function readHtml(html) {
  const anchors = [];
  const text = [];
  let rootLang = null;
  let firstLang = null;
  let anchor = null;
  let skip = 0;
  const finishAnchor = () => { if (anchor) anchors.push(anchor); anchor = null; };
  const parser = new Parser({
    onopentag(name, attrs) {
      const lang = typeof attrs.lang === 'string' ? attrs.lang.trim() : '';
      if (lang) {
        if (name === 'html' && rootLang === null) rootLang = lang;
        if (firstLang === null) firstLang = lang;
      }
      if (name === 'script' || name === 'style') skip++;
      if (name === 'a') {
        finishAnchor();
        if (typeof attrs.href === 'string') anchor = { href: attrs.href.trim(), text: '' };
      }
    },
    ontext(chunk) {
      if (skip) return;
      text.push(chunk);
      if (anchor) anchor.text += chunk;
    },
    onclosetag(name) {
      if (name === 'script' || name === 'style') skip = Math.max(0, skip - 1);
      if (name === 'a') finishAnchor();
    },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
  finishAnchor();
  return { anchors, lang: rootLang ?? firstLang, text: text.join(' ').replace(/\s+/g, ' ').trim() };
}

const EMPTY_HTML = Object.freeze({ anchors: [], lang: null, text: '' });
const readStoredHtml = bodyHtml => (typeof bodyHtml === 'string' && bodyHtml ? readHtml(bodyHtml) : EMPTY_HTML);

const bodyFrom = (bodyText, html) => (typeof bodyText === 'string' && bodyText.trim() ? bodyText : html.text);

// The message body as text: body_text, or the visible text of body_html when there is none.
export function messageBodyText({ bodyText, bodyHtml }) {
  return bodyFrom(bodyText, readStoredHtml(bodyHtml));
}

// ── Language ──────────────────────────────────────────────────────────────────

// A BCP 47 tag in canonical form, or null when the value is missing or not a valid tag.
function canonicalTag(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null;
  } catch {
    return null;
  }
}

const firstContentLanguage = value => (typeof value === 'string' ? value.split(/[,\n]/)[0] : null);

function scriptOf(letter) {
  for (const [code, re] of SCRIPTS) if (re.test(letter)) return code;
  return OTHER_SCRIPT;
}

// Counts the first MAX_LANGUAGE_LETTERS letters of `text` by script and returns the counts and the
// text up to the last counted letter, which is what the stop words are matched against.
function countScripts(text) {
  const counts = new Map();
  let letters = 0;
  let end = 0;
  let offset = 0;
  for (const ch of text) {
    offset += ch.length;
    if (!LETTER.test(ch)) continue;
    const code = scriptOf(ch);
    counts.set(code, (counts.get(code) || 0) + 1);
    end = offset;
    if (++letters === MAX_LANGUAGE_LETTERS) break;
  }
  let dominant = null;
  for (const [code, n] of counts) if (dominant === null || n > counts.get(dominant)) dominant = code;
  return { counts, letters, dominant, sample: text.slice(0, end) };
}

// The stop-word language of a Latin or Cyrillic sample: the language with the most stop-word
// occurrences, when it has at least STOP_WORD_MIN_HITS and STOP_WORD_LEAD times the runner-up.
function stopWordLanguage(sample) {
  const tokens = sample.toLowerCase().replaceAll('\u2019', "'").match(/[\p{L}\p{M}]+'?/gu) || [];
  const hits = STOP_WORD_LANGUAGES.map(language => {
    const words = STOP_WORDS[language];
    let n = 0;
    for (const token of tokens) {
      if (words.has(token) || (token.endsWith("'") && words.has(token.slice(0, -1)))) n++;
    }
    return [language, n];
  }).sort((a, b) => b[1] - a[1]);
  const [[best, top], [, second]] = hits;
  return top >= STOP_WORD_MIN_HITS && top >= second * STOP_WORD_LEAD ? best : null;
}

// resolveLanguage({ subject, bodyText, bodyHtml, contentLanguage }) →
//   { resolved, declared: { htmlLang, contentLanguage }, script: { dominant, letters } }
// `resolved` is a BCP 47 tag decided by the K5 rules in order; a declaration contributes its
// primary language subtag. `declared` keeps both declarations in canonical form (null when absent
// or invalid) whether or not they won.
export function resolveLanguage({ subject, bodyText, bodyHtml, contentLanguage }) {
  return languageOf({ subject, bodyText, html: readStoredHtml(bodyHtml), contentLanguage });
}

function languageOf({ subject, bodyText, html, contentLanguage }) {
  const text = `${typeof subject === 'string' ? subject : ''}\n${bodyFrom(bodyText, html)}`.normalize('NFC');
  const { counts, letters, dominant, sample } = countScripts(text);
  const declared = {
    htmlLang: canonicalTag(html.lang),
    contentLanguage: canonicalTag(firstContentLanguage(contentLanguage)),
  };
  const declaredTag = declared.htmlLang ?? declared.contentLanguage;
  const declaredLocale = declaredTag === null ? null : new Intl.Locale(declaredTag);
  const declaredLanguage = declaredLocale?.language ?? null;

  const resolved = (() => {
    if (letters > 0 && (counts.get('Hrkt') || 0) / letters >= KANA_SHARE_FOR_JA) return 'ja';
    if (Object.hasOwn(STRONG_SCRIPT_LANGUAGE, dominant)) return STRONG_SCRIPT_LANGUAGE[dominant];
    if (dominant === 'Hani') return HAN_DECLARABLE.has(declaredLanguage) ? declaredLanguage : 'zh';
    if (dominant === 'Latn' || dominant === 'Cyrl') {
      const byStopWords = stopWordLanguage(sample);
      if (byStopWords) return byStopWords;
      if (declaredLocale && declaredLocale.maximize().script === dominant) return declaredLanguage;
      return `und-${dominant}`;
    }
    return declaredLanguage ?? 'und';
  })();

  return { resolved, declared, script: { dominant, letters } };
}

// ── Message signals ───────────────────────────────────────────────────────────

const address = entry => ({ name: entry?.name || null, email: entry?.email || null });
const addressList = value => (Array.isArray(value) ? value : []);

function authenticationOf(headers, account) {
  switch (headers.kind) {
    case 'unavailable':
      return { kind: 'headers_unavailable', reason: headers.reason };
    case 'stored': {
      const authservIds = extractAuthservIds(headers.headers);
      if (authservIds.length === 0) return { kind: 'absent' };
      // The same gate as spamPipeline: only the account's current trusted authserv-id vouches.
      const trusted = normalizeAuthservId(account.trusted_authserv_id);
      if (trusted === null || !authservIds.includes(trusted)) return { kind: 'untrusted', authservIds };
      const { spf, dkim, dmarc } = parseAuthResults(headers.headers, { trustedAuthservIds: trusted });
      return { kind: 'trusted', authservId: trusted, spf, dkim, dmarc };
    }
    default:
      throw new Error(`unhandled header result kind ${headers.kind}`);
  }
}

function linkOf({ href, text }) {
  const hrefHost = hostOfUrl(href);
  if (hrefHost === null) return null;
  const shown = text.replace(/\s+/g, ' ').trim();
  const textHost = URL_LIKE_TEXT.test(shown) ? hostOfUrl(/^https?:\/\//i.test(shown) ? shown : `http://${shown}`) : null;
  const hrefDomain = registrableDomain(hrefHost);
  const textDomain = textHost === null ? null : registrableDomain(textHost);
  return {
    href,
    hrefHost,
    hrefDomain,
    text: shown.slice(0, MAX_LINK_TEXT),
    textHost,
    textDomain,
    mismatch: textDomain !== null && textDomain !== hrefDomain,
  };
}

function linksOf(anchors) {
  const links = [];
  for (const anchor of anchors) {
    const link = linkOf(anchor);
    if (link) links.push(link);
    if (links.length === MAX_LINKS) break;
  }
  return links;
}

const storedHeader = (headers, name) => {
  if (headers.kind !== 'stored') return null;
  const value = headers.headers[name];
  return typeof value === 'string' && value.trim() ? value.split('\n')[0].trim() : null;
};

// extractSignals({ message, headers, account }) → MessageSignals
//   message: a messages row; headers: the K4 result for it; account: its email_accounts row (only
//   trusted_authserv_id is read, at call time, so a changed setting applies without re-ingest).
export function extractSignals({ message, headers, account }) {
  const html = readStoredHtml(message.body_html);
  return {
    sender: {
      from: { name: message.from_name || null, email: message.from_email || null },
      sender: message.sender_email ? { name: message.sender_name || null, email: message.sender_email } : null,
      replyTo: addressList(message.reply_to).map(address),
    },
    recipients: { to: addressList(message.to_addresses).length, cc: addressList(message.cc_addresses).length },
    subject: message.subject ?? null,
    date: message.date == null ? null : new Date(message.date).toISOString(),
    thread: { isReply: Boolean(message.in_reply_to) },
    authentication: authenticationOf(headers, account),
    links: linksOf(html.anchors),
    attachments: addressList(message.attachments).map(a => ({ filename: a?.filename ?? null, type: a?.type ?? null })),
    mailingList: {
      listUnsubscribe: message.list_unsubscribe || null,
      listId: storedHeader(headers, 'list-id'),
      bulk: Boolean(message.is_bulk),
    },
    language: languageOf({
      subject: message.subject,
      bodyText: message.body_text,
      html,
      contentLanguage: storedHeader(headers, 'content-language'),
    }),
  };
}

const SIGNAL_COLUMNS = `m.id, m.from_name, m.from_email, m.sender_name, m.sender_email, m.reply_to,
       m.to_addresses, m.cc_addresses, m.subject, m.date, m.in_reply_to, m.body_text, m.body_html,
       m.attachments, m.list_unsubscribe, m.is_bulk, a.trusted_authserv_id`;

async function loadSignals(rows, deadlineMs) {
  const signals = new Map();
  if (rows.length === 0) return signals;
  const headers = await getMessageHeaders(rows.map(row => row.id), { deadlineMs });
  for (const row of rows) {
    signals.set(row.id, extractSignals({
      message: row,
      headers: headers.get(row.id),
      account: { trusted_authserv_id: row.trusted_authserv_id },
    }));
  }
  return signals;
}

// getMessageSignals(messageIds, { deadlineMs }) → Map<id, MessageSignals>
// One query for the rows, one K4 read for all their headers (deadlineMs goes to it), then
// extraction. An id with no messages row is absent from the Map.
export async function getMessageSignals(messageIds, { deadlineMs } = {}) {
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return new Map();
  const { rows } = await query(
    `SELECT ${SIGNAL_COLUMNS}
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = ANY($1::uuid[])`,
    [ids],
  );
  return loadSignals(rows, deadlineMs);
}

// The account-scoped form the plugin API exposes: an id that is not a message of `accountId` is
// absent from the Map, like a missing one.
export async function getAccountMessageSignals(accountId, messageIds, { deadlineMs } = {}) {
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return new Map();
  const { rows } = await query(
    `SELECT ${SIGNAL_COLUMNS}
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE m.account_id = $1 AND m.id = ANY($2::uuid[])`,
    [accountId, ids],
  );
  return loadSignals(rows, deadlineMs);
}
