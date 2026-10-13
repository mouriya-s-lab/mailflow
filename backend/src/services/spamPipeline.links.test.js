// The link rules in classification (mouriya-s-lab/mailflow#16): the domain lookup (K6) is mocked,
// everything from the stored row to spam_details is real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('./spamModelStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getModelForUser: vi.fn(),
}));
vi.mock('../../fork-features/reputation/index.js', () => ({ lookupRdap: vi.fn(), lookupSpamhausDbl: vi.fn(), lookupUrlhaus: vi.fn() }));

import { query } from './db.js';
import { getModelForUser } from './spamModelStore.js';
import { lookupRdap, lookupSpamhausDbl, lookupUrlhaus } from '../../fork-features/reputation/index.js';
import { classifyAndTagMessage } from './spamPipeline.js';
import { RULES } from './spamRules.js';

const MESSAGE_ID = 'mmmmmmmm-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DAY_MS = 24 * 60 * 60 * 1000;

const PHISH_HTML = '<p>Dear customer, verify your account.</p>'
  + '<a href="https://cmb-verify-login.xyz/login">www.cmbchina.com</a>';
const NOTICE_HTML = '<p>Your statement is ready.</p><a href="https://www.cmbchina.com/statement">查看账单</a>';
const ONE_LINK_HTML = domain => `<p>Hello</p><a href="https://${domain}/offer">Open the offer</a>`;

function messageRow(overrides = {}) {
  return {
    id: MESSAGE_ID,
    account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    owner_id: 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu',
    account_email: 'user@example.com',
    antispam_enabled: true,
    master_spam_enabled: null,
    folder_mappings: { spam: 'Junk' },
    folder: 'INBOX',
    uid: 100,
    message_id: '<link-test@mailflow-test.invalid>',
    subject: 'Account notice',
    body_text: null,
    body_html: PHISH_HTML,
    from_email: 'notice@example.org',
    attachments: [],
    spam_user_override: null,
    ...overrides,
  };
}

const NOT_LISTED = { kind: 'not_listed' };
const UNCONFIGURED = { kind: 'unconfigured' };
const domainLookups = [lookupRdap, lookupSpamhausDbl, lookupUrlhaus];
function answer(domain, registration, listings = { spamhaus_dbl: UNCONFIGURED, urlhaus: UNCONFIGURED }) {
  lookupRdap.mockResolvedValue(new Map([[domain, registration]]));
  lookupSpamhausDbl.mockResolvedValue(new Map([[domain, listings.spamhaus_dbl]]));
  lookupUrlhaus.mockResolvedValue(new Map([[domain, listings.urlhaus]]));
}
const registeredDaysAgo = days => ({ kind: 'known', registeredAt: new Date(Date.now() - days * DAY_MS).toISOString() });

// spam_details as written by the classification UPDATE.
function storedDetails() {
  const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE messages SET'));
  return JSON.parse(update[1][2]);
}
const fired = () => storedDetails().rulesFired.map(r => r.name);
const NEGATIVE_RULES = RULES.filter(r => r.weight < 0).map(r => r.name);

async function classify(row) {
  query.mockResolvedValueOnce({ rows: [row] });
  return classifyAndTagMessage(MESSAGE_ID, {});
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  getModelForUser.mockReset();
  getModelForUser.mockResolvedValue(null);
  for (const lookup of domainLookups) {
    lookup.mockReset();
    lookup.mockResolvedValue(new Map());
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LINK_TEXT_DOMAIN_MISMATCH', () => {
  it('fires when a link shows one domain and goes to another', async () => {
    answer('cmb-verify-login.xyz', { kind: 'not_found' });
    await classify(messageRow());
    expect(fired()).toContain('LINK_TEXT_DOMAIN_MISMATCH');
    expect(storedDetails().rulesFired).toContainEqual({ name: 'LINK_TEXT_DOMAIN_MISMATCH', weight: 0.5 });
  });

  it('does not fire for a link whose text is not an address', async () => {
    answer('cmbchina.com', registeredDaysAgo(9000));
    await classify(messageRow({ body_html: NOTICE_HTML }));
    expect(fired()).not.toContain('LINK_TEXT_DOMAIN_MISMATCH');
  });

  it('stays silent, with every flag null, when the body is not stored yet', async () => {
    await classify(messageRow({ body_html: null, body_text: null }));
    for (const lookup of domainLookups) expect(lookup).not.toHaveBeenCalled();
    expect(fired().filter(name => name.startsWith('LINK_'))).toEqual([]);
    expect(storedDetails().links).toEqual({
      kind: 'body_unavailable',
      flags: { link_text_domain_mismatch: null, link_domain_new: null, link_domain_listed: null },
    });
  });
});

describe('LINK_DOMAIN_NEW', () => {
  it('fires for a link to a domain registered this month', async () => {
    answer('fresh-offer.example', registeredDaysAgo(5));
    await classify(messageRow({ body_html: ONE_LINK_HTML('fresh-offer.example') }));
    expect(storedDetails().rulesFired).toContainEqual({ name: 'LINK_DOMAIN_NEW', weight: 0.4 });
  });

  it('does not fire for a link to an old domain', async () => {
    answer('example.com', registeredDaysAgo(11000));
    await classify(messageRow({ body_html: ONE_LINK_HTML('example.com') }));
    expect(fired()).not.toContain('LINK_DOMAIN_NEW');
    expect(storedDetails().links.flags.link_domain_new).toBe(0);
  });

  it('result 3: RDAP unknown neither fires it nor fires any minus rule, and spam_details says unknown', async () => {
    answer('fresh-offer.example', { kind: 'unknown', reason: 'error' });
    await classify(messageRow({ body_html: ONE_LINK_HTML('fresh-offer.example') }));
    expect(fired()).not.toContain('LINK_DOMAIN_NEW');
    expect(fired().filter(name => NEGATIVE_RULES.includes(name))).toEqual([]);
    const details = storedDetails();
    expect(details.links.domains['fresh-offer.example'].registration).toEqual({ kind: 'unknown', reason: 'error' });
    expect(details.links.flags.link_domain_new).toBeNull();
  });
});

describe('LINK_DOMAIN_LISTED', () => {
  const classifyWithListing = async verdict => {
    answer('fresh-offer.example', { kind: 'not_found' }, { spamhaus_dbl: verdict, urlhaus: UNCONFIGURED });
    await classify(messageRow({ body_html: ONE_LINK_HTML('fresh-offer.example') }));
    return storedDetails();
  };

  it('fires with weight 0.6 when a source lists the domain', async () => {
    const details = await classifyWithListing({ kind: 'listed', detail: 'phishing domain' });
    expect(details.rulesFired).toContainEqual({ name: 'LINK_DOMAIN_LISTED', weight: 0.6 });
    expect(details.links.flags.link_domain_listed).toBe(1);
  });

  it('does not fire when the source says not_listed', async () => {
    const details = await classifyWithListing(NOT_LISTED);
    expect(details.rulesFired.map(r => r.name)).not.toContain('LINK_DOMAIN_LISTED');
    expect(details.links.flags.link_domain_listed).toBe(0);
  });

  it('does not fire, and records unknown, when the source could not answer', async () => {
    const details = await classifyWithListing({ kind: 'unknown', reason: 'rate_limited' });
    expect(details.rulesFired.map(r => r.name)).not.toContain('LINK_DOMAIN_LISTED');
    expect(details.rulesFired.map(r => r.name).filter(name => NEGATIVE_RULES.includes(name))).toEqual([]);
    expect(details.links.domains['fresh-offer.example'].listings.spamhaus_dbl).toEqual({ kind: 'unknown', reason: 'rate_limited' });
    expect(details.links.flags.link_domain_listed).toBeNull();
  });
});

describe('result 5: the lookup cannot hold classification up, and only runs with anti-spam on', () => {
  it('finishes at the 5 s deadline when the lookup never answers, with every source unknown', async () => {
    vi.useFakeTimers();
    lookupRdap.mockReturnValue(new Promise(() => {}));
    query.mockResolvedValueOnce({ rows: [messageRow({ body_html: ONE_LINK_HTML('fresh-offer.example') })] });
    let result;
    const run = classifyAndTagMessage(MESSAGE_ID, {}).then(r => { result = r; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(result.verdict).toBeDefined();
    const reputation = storedDetails().links.domains['fresh-offer.example'];
    expect(reputation.registration).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(reputation.listings.spamhaus_dbl).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(reputation.listings.urlhaus).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(storedDetails().links.flags).toEqual({ link_text_domain_mismatch: 0, link_domain_new: null, link_domain_listed: null });
  });

  it('does not look anything up for an account with anti-spam off', async () => {
    const result = await classify(messageRow({ antispam_enabled: false }));
    expect(result).toEqual({ skipped: 'antispam_disabled' });
    for (const lookup of domainLookups) expect(lookup).not.toHaveBeenCalled();
  });

  it("does not look anything up when the user's anti-spam master switch is off", async () => {
    const result = await classify(messageRow({ master_spam_enabled: 'false' }));
    expect(result).toEqual({ skipped: 'spam_disabled' });
    for (const lookup of domainLookups) expect(lookup).not.toHaveBeenCalled();
  });
});
