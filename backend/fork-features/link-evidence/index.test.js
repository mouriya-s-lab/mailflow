import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../reputation/index.js', () => ({ lookupRdap: vi.fn(), lookupSpamhausDbl: vi.fn(), lookupUrlhaus: vi.fn() }));

import { logger } from '../../src/services/logger.js';
import { lookupRdap, lookupSpamhausDbl, lookupUrlhaus } from '../reputation/index.js';
import { LINK_LOOKUP_DEADLINE_MS, linkEvidenceFor, linkFlags } from './index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECKED_AT = '2026-10-12T00:00:00.000Z';
const registeredDaysBefore = days => new Date(Date.parse(CHECKED_AT) - days * DAY_MS).toISOString();

const PHISH_HTML = '<p>Your account is locked.</p>'
  + '<a href="https://cmb-verify-login.xyz/login">www.cmbchina.com</a>'
  + '<a href="https://www.cmb-verify-login.xyz/help">Help</a>';
const NOTICE_HTML = '<p>Your statement is ready.</p><a href="https://www.cmbchina.com/statement">查看账单</a>';

const NOT_LISTED = { kind: 'not_listed' };
const UNCONFIGURED = { kind: 'unconfigured' };
const reputation = (registration, listings = { spamhaus_dbl: UNCONFIGURED, urlhaus: UNCONFIGURED }) => ({ registration, listings });
const checked = domains => ({ kind: 'checked', checkedAt: CHECKED_AT, mismatch: false, domains });
const domainLookups = [lookupRdap, lookupSpamhausDbl, lookupUrlhaus];
function answerReputation(domains) {
  lookupRdap.mockResolvedValue(new Map([...domains].map(([domain, value]) => [domain, value.registration])));
  lookupSpamhausDbl.mockResolvedValue(new Map([...domains].map(([domain, value]) => [domain, value.listings.spamhaus_dbl])));
  lookupUrlhaus.mockResolvedValue(new Map([...domains].map(([domain, value]) => [domain, value.listings.urlhaus])));
}

beforeEach(() => {
  for (const lookup of domainLookups) {
    lookup.mockReset();
    lookup.mockResolvedValue(new Map());
  }
  logger.warn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('linkEvidenceFor', () => {
  it('sees nothing when the body is not stored yet, and looks nothing up', async () => {
    await expect(linkEvidenceFor({ body_html: null, body_text: null }, { lookUpReputation: true }))
      .resolves.toEqual({ kind: 'body_unavailable' });
    for (const lookup of domainLookups) expect(lookup).not.toHaveBeenCalled();
  });

  it('looks up each destination domain once, with the 5 s deadline', async () => {
    answerReputation(new Map([['cmb-verify-login.xyz', reputation({ kind: 'not_found' })]]));
    const evidence = await linkEvidenceFor({ body_html: PHISH_HTML, body_text: null }, { lookUpReputation: true });
    for (const lookup of domainLookups) {
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith(['cmb-verify-login.xyz'], { deadlineMs: LINK_LOOKUP_DEADLINE_MS });
    }
    expect(evidence).toMatchObject({
      kind: 'checked',
      mismatch: true,
      domains: { 'cmb-verify-login.xyz': { registration: { kind: 'not_found' } } },
    });
  });

  it('does not count a link whose text is not an address as a mismatch', async () => {
    answerReputation(new Map([['cmbchina.com', reputation({ kind: 'known', registeredAt: '1998-05-01T00:00:00.000Z' })]]));
    const evidence = await linkEvidenceFor({ body_html: NOTICE_HTML, body_text: null }, { lookUpReputation: true });
    expect(evidence.mismatch).toBe(false);
    expect(Object.keys(evidence.domains)).toEqual(['cmbchina.com']);
  });

  it('has nothing to look up for a body without links', async () => {
    const evidence = await linkEvidenceFor({ body_html: null, body_text: 'see https://example.com' }, { lookUpReputation: true });
    expect(evidence).toMatchObject({ kind: 'checked', mismatch: false, domains: {} });
    for (const lookup of domainLookups) expect(lookup).not.toHaveBeenCalled();
  });

  it('only reads the links when the lookup is switched off', async () => {
    await expect(linkEvidenceFor({ body_html: PHISH_HTML, body_text: null }, { lookUpReputation: false }))
      .resolves.toEqual({ kind: 'lookup_disabled', mismatch: true });
    for (const lookup of domainLookups) expect(lookup).not.toHaveBeenCalled();
  });

  it('makes every source unknown when the lookup never answers, at the deadline', async () => {
    vi.useFakeTimers();
    lookupRdap.mockReturnValue(new Promise(() => {}));
    const pending = linkEvidenceFor({ body_html: PHISH_HTML, body_text: null }, { lookUpReputation: true });
    let settled = false;
    pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(LINK_LOOKUP_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const evidence = await pending;
    expect(evidence.domains['cmb-verify-login.xyz']).toEqual({
      registration: { kind: 'unknown', reason: 'timeout' },
      listings: { spamhaus_dbl: { kind: 'unknown', reason: 'timeout' }, urlhaus: { kind: 'unknown', reason: 'timeout' } },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).not.toContain('cmb-verify-login');
  });

  it('makes every source unknown when the lookup fails, and handles a rejection after the deadline', async () => {
    lookupRdap.mockRejectedValueOnce(new Error('could not decrypt the stored key'));
    const failed = await linkEvidenceFor({ body_html: PHISH_HTML, body_text: null }, { lookUpReputation: true });
    expect(failed.domains['cmb-verify-login.xyz']).toEqual({
      registration: { kind: 'unknown', reason: 'error' },
      listings: { spamhaus_dbl: { kind: 'unknown', reason: 'error' }, urlhaus: { kind: 'unknown', reason: 'error' } },
    });

    vi.useFakeTimers();
    let reject;
    lookupRdap.mockReturnValueOnce(new Promise((_resolve, r) => { reject = r; }));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const pending = linkEvidenceFor({ body_html: PHISH_HTML, body_text: null }, { lookUpReputation: true });
      await vi.advanceTimersByTimeAsync(LINK_LOOKUP_DEADLINE_MS);
      expect((await pending).domains['cmb-verify-login.xyz'].registration.reason).toBe('timeout');
      reject(new Error('late failure'));
      vi.useRealTimers();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('makes every source for every domain unknown when only URLhaus rejects, and warns', async () => {
    vi.useFakeTimers();
    // Move beyond the warning throttle shared by earlier failed lookups.
    vi.setSystemTime(Date.now() + 120_000);
    const domains = ['cmb-verify-login.xyz', 'cmbchina.com'];
    answerReputation(new Map(domains.map(domain => [domain, reputation(
      { kind: 'known', registeredAt: '1998-05-01T00:00:00.000Z' },
      { spamhaus_dbl: NOT_LISTED, urlhaus: NOT_LISTED },
    )])));
    lookupUrlhaus.mockRejectedValueOnce(new Error('URLhaus lookup failed'));

    const evidence = await linkEvidenceFor({ body_html: PHISH_HTML + NOTICE_HTML, body_text: null }, { lookUpReputation: true });

    expect(evidence.domains).toEqual(Object.fromEntries(domains.map(domain => [domain, {
      registration: { kind: 'unknown', reason: 'error' },
      listings: { spamhaus_dbl: { kind: 'unknown', reason: 'error' }, urlhaus: { kind: 'unknown', reason: 'error' } },
    }])));
    for (const lookup of domainLookups) {
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith(domains, { deadlineMs: LINK_LOOKUP_DEADLINE_MS });
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('URLhaus lookup failed'));
  });
});

describe('linkFlags', () => {
  it('cannot tell anything without a body', () => {
    expect(linkFlags({ kind: 'body_unavailable' }))
      .toEqual({ link_text_domain_mismatch: null, link_domain_new: null, link_domain_listed: null });
  });

  it('has only the mismatch when no lookup was made', () => {
    expect(linkFlags({ kind: 'lookup_disabled', mismatch: true }))
      .toEqual({ link_text_domain_mismatch: 1, link_domain_new: null, link_domain_listed: null });
  });

  it('says no for a body without links', () => {
    expect(linkFlags(checked({})))
      .toEqual({ link_text_domain_mismatch: 0, link_domain_new: 0, link_domain_listed: 0 });
  });

  describe('link_domain_new', () => {
    const newFlag = (...registrations) => linkFlags(checked(Object.fromEntries(
      registrations.map((registration, i) => [`d${i}.example`, reputation(registration)]),
    ))).link_domain_new;
    const known = days => ({ kind: 'known', registeredAt: registeredDaysBefore(days) });

    it('is 1 for a domain registered less than 30 days before the check', () => {
      expect(newFlag(known(3))).toBe(1);
      expect(newFlag(known(30 - 1 / (24 * 60)))).toBe(1);
    });

    it('is 0 from 30 days on and for not_found', () => {
      expect(newFlag(known(30))).toBe(0);
      expect(newFlag(known(4000))).toBe(0);
      expect(newFlag({ kind: 'not_found' })).toBe(0);
    });

    it('is null when a registration is unknown and none is new', () => {
      expect(newFlag({ kind: 'unknown', reason: 'timeout' })).toBeNull();
      expect(newFlag(known(4000), { kind: 'unknown', reason: 'disabled' })).toBeNull();
      expect(newFlag({ kind: 'known', registeredAt: 'not a date' })).toBeNull();
      expect(newFlag(known(-1))).toBeNull();
    });

    it('is 1 when one domain is new even if another is unknown', () => {
      expect(newFlag({ kind: 'unknown', reason: 'rate_limited' }, known(2))).toBe(1);
    });
  });

  describe('link_domain_listed', () => {
    const listedFlag = (...listings) => linkFlags(checked(Object.fromEntries(
      listings.map((l, i) => [`d${i}.example`, reputation({ kind: 'not_found' }, l)]),
    ))).link_domain_listed;

    it('is 1 when any source lists any domain', () => {
      expect(listedFlag(
        { spamhaus_dbl: NOT_LISTED, urlhaus: NOT_LISTED },
        { spamhaus_dbl: { kind: 'unknown', reason: 'timeout' }, urlhaus: { kind: 'listed', detail: '3 malware URLs seen on this host' } },
      )).toBe(1);
    });

    it('is 0 when the configured sources say not_listed', () => {
      expect(listedFlag({ spamhaus_dbl: NOT_LISTED, urlhaus: UNCONFIGURED })).toBe(0);
    });

    it('is null when a source is unknown, or when no source is configured', () => {
      expect(listedFlag({ spamhaus_dbl: NOT_LISTED, urlhaus: { kind: 'unknown', reason: 'error' } })).toBeNull();
      expect(listedFlag({ spamhaus_dbl: UNCONFIGURED, urlhaus: UNCONFIGURED })).toBeNull();
    });
  });
});
