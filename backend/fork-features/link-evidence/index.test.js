import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../message-tags/index.js', async importOriginal => ({ ...(await importOriginal()), ensureMessageTags: vi.fn() }));

import { ensureMessageTags } from '../message-tags/index.js';
import { reputationUrlSubject } from '../reputation/index.js';
import { linkEvidenceFor, linkFlags } from './index.js';

const CHECKED_AT = '2026-10-12T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;
const domain = 'cmb-verify-login.xyz';
const url = `https://${domain}/login`;
const digest = reputationUrlSubject(url).urlDigest;
const complete = subjects => ({ kind: 'complete', checkedAt: CHECKED_AT, subjects });
const inactive = { kind: 'inactive' };
const unconfigured = { kind: 'unconfigured' };
const unknown = { kind: 'unknown', reason: 'timeout' };
const notListed = { kind: 'not_listed' };
const hit = { kind: 'listed', detail: 'phishing' };
const known = days => ({ kind: 'known', registeredAt: new Date(Date.parse(CHECKED_AT) - days * DAY_MS).toISOString() });
const evidence = overrides => ({
  kind: 'checked', mismatch: false, links: { domains: [domain], urlDigests: [digest] },
  tags: { rdap: inactive, spamhaus_dbl: inactive, urlhaus: inactive, safe_browsing: inactive, ...overrides },
});
const flags = overrides => linkFlags(evidence(overrides));
const message = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  body_html: `<a href="${url}">www.cmbchina.com</a><a href="${url}">help</a>`, body_text: null,
};

beforeEach(() => ensureMessageTags.mockReset());

describe('linkEvidenceFor', () => {
  it('aligns current link identities with unchanged plugin snapshots and retains mismatch', async () => {
    const tags = evidence({ rdap: complete({ [domain]: known(2), 'other.example': known(1) }) }).tags;
    ensureMessageTags.mockResolvedValue(new Map([[message.id, tags]]));
    const result = await linkEvidenceFor(message, { lookUpReputation: true });
    expect(result).toEqual({ kind: 'checked', mismatch: true, links: { domains: [domain], urlDigests: [digest] }, tags });
    expect(result.tags).toBe(tags);
    expect(linkFlags(result).link_domain_new).toBe(1);
  });

  it('cannot observe anything without a stored body', async () => {
    const result = await linkEvidenceFor({ ...message, body_html: null }, { lookUpReputation: true });
    expect(linkFlags(result)).toEqual({ link_text_domain_mismatch: null, link_domain_new: null, link_domain_listed: null, link_url_unsafe: null });
    expect(ensureMessageTags).not.toHaveBeenCalled();
  });

  it('only observes mismatch with anti-spam off', async () => {
    const result = await linkEvidenceFor(message, { lookUpReputation: false });
    expect(linkFlags(result)).toEqual({ link_text_domain_mismatch: 1, link_domain_new: null, link_domain_listed: null, link_url_unsafe: null });
    expect(ensureMessageTags).not.toHaveBeenCalled();
  });
});

describe('tag-derived flags', () => {
  for (const state of [inactive, unconfigured, ...['plugin_failed', 'deadline', 'body_unavailable'].map(reason => ({ kind: 'unavailable', reason }))]) {
    it(`keeps ${state.kind}/${state.reason ?? ''} neutral, not clean`, () => {
      expect(flags(Object.fromEntries(['rdap', 'spamhaus_dbl', 'urlhaus', 'safe_browsing'].map(source => [source, state]))))
        .toEqual({ link_text_domain_mismatch: 0, link_domain_new: null, link_domain_listed: null, link_url_unsafe: null });
    });
  }

  it('uses the RDAP snapshot time and the strict 30-day boundary', () => {
    for (const [days, expected] of [[2, 1], [30 - 1 / 1440, 1], [30, 0], [4000, 0], [-1, null]]) {
      expect(flags({ rdap: complete({ [domain]: known(days) }) }).link_domain_new).toBe(expected);
    }
    expect(flags({ rdap: complete({ [domain]: { kind: 'not_found' } }) }).link_domain_new).toBe(0);
    expect(flags({ rdap: complete({ [domain]: unknown }) }).link_domain_new).toBeNull();
    expect(flags({ rdap: complete({ [domain]: { kind: 'known', registeredAt: 'bad' } }) }).link_domain_new).toBeNull();
  });

  it('does not invent answers for subjects absent from a complete snapshot', () => {
    expect(flags({ rdap: complete({}), spamhaus_dbl: complete({}), urlhaus: complete({}), safe_browsing: complete({}) }))
      .toEqual({ link_text_domain_mismatch: 0, link_domain_new: null, link_domain_listed: null, link_url_unsafe: null });
  });

  it('ignores listed subjects that are not among the current links', () => {
    expect(flags({
      rdap: complete({ [domain]: known(4000), 'other.example': known(1) }),
      spamhaus_dbl: complete({ [domain]: notListed, 'other.example': hit }),
      safe_browsing: complete({ [digest]: { host: domain, verdict: notListed }, other: { host: 'other.example', verdict: hit } }),
    })).toEqual({ link_text_domain_mismatch: 0, link_domain_new: 0, link_domain_listed: 0, link_url_unsafe: 0 });
  });

  it('lets any domain listing win over missing or failed answers', () => {
    for (const source of ['spamhaus_dbl', 'urlhaus']) {
      expect(flags({ spamhaus_dbl: complete({}), urlhaus: { kind: 'unavailable', reason: 'deadline' }, [source]: complete({ [domain]: hit }) }).link_domain_listed).toBe(1);
    }
  });

  it('does not let an absent source invalidate an answered source, but unknowns do', () => {
    for (const state of [inactive, unconfigured]) {
      expect(flags({ spamhaus_dbl: complete({ [domain]: notListed }), urlhaus: state }).link_domain_listed).toBe(0);
    }
    for (const state of [complete({}), complete({ [domain]: unknown }), { kind: 'unavailable', reason: 'plugin_failed' }]) {
      expect(flags({ spamhaus_dbl: complete({ [domain]: notListed }), urlhaus: state }).link_domain_listed).toBeNull();
    }
  });

  it('uses URL verdicts, with a listing winning over an unknown URL', () => {
    const result = evidence({ safe_browsing: complete({ [digest]: { host: domain, verdict: hit }, second: { host: domain, verdict: unknown } }) });
    result.links.urlDigests.push('second');
    expect(linkFlags(result).link_url_unsafe).toBe(1);
    expect(flags({ safe_browsing: complete({ [digest]: { host: domain, verdict: notListed } }) }).link_url_unsafe).toBe(0);
    expect(flags({ safe_browsing: complete({ [digest]: { host: domain, verdict: unknown } }) }).link_url_unsafe).toBeNull();
  });

  it('accepts empty complete snapshots only for a message with no link subjects', () => {
    const result = evidence(Object.fromEntries(['rdap', 'spamhaus_dbl', 'urlhaus', 'safe_browsing'].map(source => [source, complete({})])));
    result.links = { domains: [], urlDigests: [] };
    expect(linkFlags(result)).toEqual({ link_text_domain_mismatch: 0, link_domain_new: 0, link_domain_listed: 0, link_url_unsafe: 0 });
  });
});
