#!/usr/bin/env node
// Jev probe: builds the Jev decision state from MailFlow message-shaped fixtures and sends it
// to the configured Jev endpoint, once with the full structured state and once with subject
// and body only, so the effect of each field on the answers can be compared.
//
//   JEV_API_KEY=… node backend/fork-features/jev-probe/probe.js [--fixtures DIR] [--questions FILE] [--mode full|body|both] [--print-state]
//
// The request goes through the Jev client (../jev), which reads JEV_API_KEY, JEV_BASE_URL and
// JEV_MODEL; the base URL defaults to the Command Code provider endpoint and the model to typesafe/jev.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Parser } from 'htmlparser2';
import { decide, status } from '../jev/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_CHARS = 20_000;

const SCRIPTS = [
  ['Han', /\p{Script=Han}/u],
  ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Latin', /\p{Script=Latin}/u],
];

function dominantScript(text) {
  const counts = new Map();
  for (const ch of text) {
    for (const [name, re] of SCRIPTS) {
      if (re.test(ch)) { counts.set(name, (counts.get(name) || 0) + 1); break; }
    }
  }
  let best = null;
  for (const [name, n] of counts) if (!best || n > best[1]) best = [name, n];
  return best ? best[0] : null;
}

function hostOf(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function textDomain(text) {
  const match = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?/i.exec(text.trim());
  return match && match[0].length >= text.trim().length * 0.6 ? match[1].toLowerCase() : null;
}

// Links as the reader sees them (anchor text) against where they actually go (href host),
// plus the first lang attribute and the visible text, from one pass over the stored HTML.
function readHtml(html) {
  const links = [];
  const text = [];
  let lang = null;
  let anchor = null;
  let skip = 0;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (!lang && attrs.lang) lang = attrs.lang;
      if (name === 'script' || name === 'style') skip++;
      if (name === 'a' && attrs.href) anchor = { href: attrs.href, text: '' };
    },
    ontext(chunk) {
      if (skip) return;
      text.push(chunk);
      if (anchor) anchor.text += chunk;
    },
    onclosetag(name) {
      if (name === 'script' || name === 'style') skip = Math.max(0, skip - 1);
      if (name === 'a' && anchor) {
        const hrefDomain = hostOf(anchor.href);
        if (hrefDomain) {
          const shown = anchor.text.replace(/\s+/g, ' ').trim();
          links.push({ text: shown.slice(0, 200), text_domain: textDomain(shown), href_domain: hrefDomain });
        }
        anchor = null;
      }
    },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
  return { links, lang, text: text.join(' ').replace(/\s+/g, ' ').trim() };
}

// Authentication-Results is honoured only when its authserv-id is the one the account trusts,
// mirroring spamPipeline; anything else is reported as untrusted so a forged header can't vouch
// for the sender.
function readAuthentication(headers, trustedAuthservId) {
  const line = (headers || []).find(h => /^authentication-results\s*:/i.test(h));
  if (!line) return { present: false };
  const value = line.replace(/^authentication-results\s*:\s*/i, '');
  const authservId = value.split(';')[0].trim().split(/\s+/)[0].toLowerCase();
  const result = method => (new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, 'i').exec(value)?.[1] || 'none').toLowerCase();
  return {
    present: true,
    trusted: Boolean(trustedAuthservId) && authservId === String(trustedAuthservId).toLowerCase(),
    spf: result('spf'),
    dkim: result('dkim'),
    dmarc: result('dmarc'),
  };
}

const addresses = list => (Array.isArray(list) ? list : []).map(a => (typeof a === 'string' ? a : a?.address || a?.email)).filter(Boolean);

function fullState(msg) {
  const html = msg.body_html ? readHtml(msg.body_html) : { links: [], lang: null, text: '' };
  const body = (msg.body_text || html.text || '').slice(0, MAX_BODY_CHARS);
  return {
    from: { name: msg.from_name || null, email: msg.from_email || null },
    sender: msg.sender_email || null,
    reply_to: addresses(msg.reply_to),
    to_count: addresses(msg.to_addresses).length,
    cc_count: addresses(msg.cc_addresses).length,
    subject: msg.subject || '',
    date: msg.date || null,
    language: { html_lang: html.lang, script: dominantScript(`${msg.subject || ''} ${body}`) },
    authentication: readAuthentication(msg.headers, msg.trusted_authserv_id),
    mailing_list: { list_unsubscribe: Boolean(msg.list_unsubscribe), bulk: Boolean(msg.is_bulk) },
    thread: { is_reply: Boolean(msg.in_reply_to) },
    attachments: (msg.attachments || []).map(a => ({ filename: a.filename || a.name || null, type: a.type || a.contentType || null })),
    links: html.links,
    body_text: body,
  };
}

function bodyOnlyState(msg) {
  const body = msg.body_text || (msg.body_html ? readHtml(msg.body_html).text : '');
  return `Subject: ${msg.subject || ''}\n\n${body.slice(0, MAX_BODY_CHARS)}`;
}

function summarize(answer) {
  switch (answer.kind) {
    case 'noul': return answer.probability.toFixed(2);
    case 'choice': return `${answer.choice} (${answer.confidence})`;
    case 'score': return `${answer.score} (${answer.confidence})`;
    default: throw new Error(`unhandled answer kind ${answer.kind}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixtures: { type: 'string', default: join(HERE, 'fixtures') },
      questions: { type: 'string', default: join(HERE, 'questions.json') },
      mode: { type: 'string', default: 'both' },
      'print-state': { type: 'boolean', default: false },
    },
  });
  if (!['full', 'body', 'both'].includes(values.mode)) throw new Error(`--mode must be full, body or both (got ${values.mode})`);
  const jev = status();
  if (jev.kind === 'unconfigured') throw new Error('JEV_API_KEY is not set');

  const questions = JSON.parse(await readFile(values.questions, 'utf8'));
  const files = (await readdir(values.fixtures)).filter(f => f.endsWith('.json')).sort();
  const modes = values.mode === 'both' ? ['full', 'body'] : [values.mode];
  const questionIds = Object.keys(questions);

  console.log(`endpoint ${jev.baseUrl}  model ${jev.model}\n`);
  console.log(['fixture', 'mode', ...questionIds, 'tokens', 'ms'].join('\t'));
  let failures = 0;
  for (const file of files) {
    const msg = JSON.parse(await readFile(join(values.fixtures, file), 'utf8'));
    for (const mode of modes) {
      const state = mode === 'full' ? fullState(msg) : bodyOnlyState(msg);
      if (values['print-state']) console.log(JSON.stringify(state, null, 2));
      const started = Date.now();
      const result = await decide({ state: typeof state === 'string' ? state : JSON.stringify(state), questions });
      const latencyMs = Date.now() - started;
      const name = basename(file, '.json');
      if (result.kind === 'error') {
        failures++;
        console.log([name, mode, JSON.stringify(result.error)].join('\t'));
        continue;
      }
      console.log([name, mode, ...questionIds.map(id => summarize(result.answers[id])), result.inputTokens, latencyMs].join('\t'));
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
