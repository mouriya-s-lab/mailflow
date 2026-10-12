// Link evidence for the anti-spam rules and training records (mouriya-s-lab/mailflow#16).
//
// What a message's links say: whether a link shows one domain and goes to another (K5), and what
// the domain lookup services say about where the links go (K6). Classification and every training
// record take it from here, so the rules, spam_details and flag_features agree.
//
// The reputation lookup runs once per call with a 5 s deadline that covers all of it, including the
// parts K6 does not bound (its settings and cache queries). A source that has not answered by then,
// or a lookup that fails, is `unknown`, and an unknown never counts as "not listed" or "not new".

import { logger } from '../../src/services/logger.js';
import { messageLinks } from '../signals/index.js';
import { lookupDomains } from '../reputation/index.js';

export const LINK_LOOKUP_DEADLINE_MS = 5000;
const NEW_DOMAIN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LISTING_SOURCES = ['spamhaus_dbl', 'urlhaus'];
const WARN_INTERVAL_MS = 60_000;

// LinkEvidence:
//   { kind: 'body_unavailable' }                  — the body is not stored yet; nothing was seen
//   { kind: 'lookup_disabled', mismatch }         — anti-spam is off, so no lookup was made
//   { kind: 'checked', checkedAt, mismatch, domains: Record<domain, DomainReputation> }
// `domains` holds every distinct link destination domain with K6's answer for it, as stored.

const hasBody = message => message.body_html != null || message.body_text != null;

let lastWarning = null;
function warnLookupFailed(reason) {
  const at = Date.now();
  if (lastWarning && at - lastWarning.at < WARN_INTERVAL_MS) {
    lastWarning.suppressed++;
    return;
  }
  const suppressed = lastWarning?.suppressed ? ` (${lastWarning.suppressed} more since the last warning)` : '';
  lastWarning = { at, suppressed: 0 };
  logger.warn(`[link-evidence] link reputation lookup ${reason}; its sources count as unknown${suppressed}`);
}

const unanswered = reason => ({
  registration: { kind: 'unknown', reason },
  listings: Object.fromEntries(LISTING_SOURCES.map(source => [source, { kind: 'unknown', reason }])),
});

// K6's answer for each domain, or `unknown` for all of them when it fails or misses the deadline.
// The lookup's own promise is always handled, so a rejection after the deadline goes nowhere.
async function lookUp(domains) {
  const answer = Promise.resolve()
    .then(() => lookupDomains(domains, { deadlineMs: LINK_LOOKUP_DEADLINE_MS }))
    .then(map => ({ kind: 'answered', map }), err => ({ kind: 'failed', message: err?.message ?? String(err) }));
  let timer;
  const late = new Promise(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timed_out' }), LINK_LOOKUP_DEADLINE_MS);
  });
  const outcome = await Promise.race([answer, late]).finally(() => clearTimeout(timer));
  switch (outcome.kind) {
    case 'answered':
      return Object.fromEntries(domains.map(domain => [domain, outcome.map.get(domain) ?? unanswered('error')]));
    case 'failed':
      warnLookupFailed(`failed: ${outcome.message}`);
      return Object.fromEntries(domains.map(domain => [domain, unanswered('error')]));
    case 'timed_out':
      warnLookupFailed(`missed its ${LINK_LOOKUP_DEADLINE_MS} ms deadline`);
      return Object.fromEntries(domains.map(domain => [domain, unanswered('timeout')]));
    default:
      throw new Error(`unhandled lookup outcome ${outcome.kind}`);
  }
}

/**
 * The link evidence of a messages row (body_html and body_text are read).
 *
 * @param {{ body_html: string|null, body_text: string|null }} message
 * @param {{ lookUpReputation: boolean }} options — false when anti-spam is off for the message's
 *   account or user: no lookup service is contacted.
 * @returns {Promise<LinkEvidence>}
 */
export async function linkEvidenceFor(message, { lookUpReputation }) {
  if (!hasBody(message)) return { kind: 'body_unavailable' };
  const links = messageLinks({ bodyHtml: message.body_html });
  const mismatch = links.some(link => link.mismatch);
  if (!lookUpReputation) return { kind: 'lookup_disabled', mismatch };
  const checkedAt = new Date().toISOString();
  const domains = [...new Set(links.map(link => link.hrefDomain).filter(Boolean))];
  return { kind: 'checked', checkedAt, mismatch, domains: domains.length ? await lookUp(domains) : {} };
}

// 1 when a destination domain was registered less than 30 days before the check; null when no
// domain is that new but some registration date is unknown; else 0. A not_found registration does
// not make a domain new, and says nothing about its age either.
function domainNew(domains, checkedAt) {
  const at = Date.parse(checkedAt);
  let unknown = false;
  for (const { registration } of Object.values(domains)) {
    switch (registration.kind) {
      case 'known': {
        const age = at - Date.parse(registration.registeredAt);
        if (!(age >= 0)) unknown = true;
        else if (age < NEW_DOMAIN_MAX_AGE_MS) return 1;
        break;
      }
      case 'not_found':
        break;
      case 'unknown':
        unknown = true;
        break;
      default:
        throw new Error(`unhandled registration kind ${registration.kind}`);
    }
  }
  return unknown ? null : 0;
}

// 1 when any source lists any destination domain; 0 only when sources answered not_listed and
// none is unknown; null otherwise, including when no source is configured.
function domainListed(domains) {
  const entries = Object.values(domains);
  if (entries.length === 0) return 0;
  let unknown = false;
  let answered = false;
  for (const { listings } of entries) {
    for (const verdict of Object.values(listings)) {
      switch (verdict.kind) {
        case 'listed':
          return 1;
        case 'not_listed':
          answered = true;
          break;
        case 'unknown':
          unknown = true;
          break;
        case 'unconfigured':
          break;
        default:
          throw new Error(`unhandled listing verdict kind ${verdict.kind}`);
      }
    }
  }
  return unknown || !answered ? null : 0;
}

/**
 * The three link flags of spam_training_log.flag_features and of the rules: 1, 0, or null when the
 * evidence cannot tell.
 *
 * @param {LinkEvidence} evidence
 * @returns {{ link_text_domain_mismatch: 0|1|null, link_domain_new: 0|1|null, link_domain_listed: 0|1|null }}
 */
export function linkFlags(evidence) {
  switch (evidence.kind) {
    case 'body_unavailable':
      return { link_text_domain_mismatch: null, link_domain_new: null, link_domain_listed: null };
    case 'lookup_disabled':
      return { link_text_domain_mismatch: evidence.mismatch ? 1 : 0, link_domain_new: null, link_domain_listed: null };
    case 'checked':
      return {
        link_text_domain_mismatch: evidence.mismatch ? 1 : 0,
        link_domain_new: domainNew(evidence.domains, evidence.checkedAt),
        link_domain_listed: domainListed(evidence.domains),
      };
    default:
      throw new Error(`unhandled link evidence kind ${evidence.kind}`);
  }
}
