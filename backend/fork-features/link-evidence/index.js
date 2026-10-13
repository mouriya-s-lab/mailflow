// Link evidence for anti-spam classification and training. Reputation tags are snapshots owned
// by their plugins; the current links identify which subjects those snapshots must cover.
import { messageLinks } from '../signals/index.js';
import { ensureMessageTags, NEW_DOMAIN_MAX_AGE_MS } from '../message-tags/index.js';
import { reputationUrlSubject } from '../reputation/index.js';

export const LINK_LOOKUP_DEADLINE_MS = 5000;

// LinkEvidence:
//   { kind: 'body_unavailable' }
//   { kind: 'lookup_disabled', mismatch }
//   { kind: 'checked', mismatch, links: { domains, urlDigests }, tags }
// `links` identifies the current message's subjects without retaining URL text. `tags` is the
// unchanged T3 source record; missing subjects are unknown, not invented source verdicts.

const hasBody = message => message.body_html != null || message.body_text != null;

/**
 * @param {{ id: string, account_id: string, body_html: string|null, body_text: string|null }} message
 * @param {{ lookUpReputation: boolean }} options — false when anti-spam is off; no tags requested
 * @returns {Promise<LinkEvidence>}
 */
export async function linkEvidenceFor(message, { lookUpReputation }) {
  if (!hasBody(message)) return { kind: 'body_unavailable' };
  const links = messageLinks({ bodyHtml: message.body_html });
  const mismatch = links.some(link => link.mismatch);
  if (!lookUpReputation) return { kind: 'lookup_disabled', mismatch };
  const tags = (await ensureMessageTags(message.account_id, [message.id], {
    deadlineMs: LINK_LOOKUP_DEADLINE_MS,
  })).get(message.id);
  if (!tags) throw new Error(`message ${message.id} disappeared while requesting link tags`);
  return {
    kind: 'checked',
    mismatch,
    links: {
      domains: [...new Set(links.map(link => link.hrefDomain).filter(Boolean))],
      urlDigests: [...new Set(links.map(link => reputationUrlSubject(link.href).urlDigest))],
    },
    tags,
  };
}

// A non-complete source contributes no verdict. The aggregate distinguishes an absent input
// (inactive/unconfigured) from a failed input (unavailable); neither is a not_listed answer.
function sourceSubjects(state) {
  switch (state.kind) {
    case 'complete': return state.subjects;
    case 'inactive':
    case 'unconfigured': return null;
    case 'unavailable': return undefined;
    default: throw new Error(`unhandled ensured tag state ${state.kind}`);
  }
}

function domainNew(domains, state) {
  const subjects = sourceSubjects(state);
  if (subjects == null) return null;
  const at = Date.parse(state.checkedAt);
  let unknown = false;
  for (const domain of domains) {
    const registration = subjects[domain];
    if (!registration) { unknown = true; continue; }
    switch (registration.kind) {
      case 'known': {
        const age = at - Date.parse(registration.registeredAt);
        if (!(age >= 0)) unknown = true;
        else if (age < NEW_DOMAIN_MAX_AGE_MS) return 1;
        break;
      }
      case 'not_found': break;
      case 'unknown': unknown = true; break;
      default: throw new Error(`unhandled registration kind ${registration.kind}`);
    }
  }
  return unknown ? null : 0;
}

// Any listing wins. Otherwise a failed/missing answer makes the aggregate unknown; absent
// sources do not invalidate another source's answer. A complete empty subject set is neutral
// only when the current message has no subjects either.
function listed(subjects, states, url = false) {
  let unknown = false;
  let answered = false;
  for (const state of states) {
    const entries = sourceSubjects(state);
    if (entries === null) continue;
    if (entries === undefined) { unknown = true; continue; }
    if (subjects.length === 0) answered = true;
    for (const subject of subjects) {
      const entry = entries[subject];
      const verdict = url ? entry?.verdict : entry;
      if (!verdict) { unknown = true; continue; }
      switch (verdict.kind) {
        case 'listed': return 1;
        case 'not_listed': answered = true; break;
        case 'unknown': unknown = true; break;
        case 'unconfigured': break;
        default: throw new Error(`unhandled listing verdict kind ${verdict.kind}`);
      }
    }
  }
  return unknown || !answered ? null : 0;
}

/** The classification and training flags: 1, 0, or null when the evidence cannot tell. */
export function linkFlags(evidence) {
  switch (evidence.kind) {
    case 'body_unavailable':
      return { link_text_domain_mismatch: null, link_domain_new: null, link_domain_listed: null, link_url_unsafe: null };
    case 'lookup_disabled':
      return { link_text_domain_mismatch: evidence.mismatch ? 1 : 0, link_domain_new: null, link_domain_listed: null, link_url_unsafe: null };
    case 'checked':
      return {
        link_text_domain_mismatch: evidence.mismatch ? 1 : 0,
        link_domain_new: domainNew(evidence.links.domains, evidence.tags.rdap),
        link_domain_listed: listed(evidence.links.domains, [evidence.tags.spamhaus_dbl, evidence.tags.urlhaus]),
        link_url_unsafe: listed(evidence.links.urlDigests, [evidence.tags.safe_browsing], true),
      };
    default:
      throw new Error(`unhandled link evidence kind ${evidence.kind}`);
  }
}
