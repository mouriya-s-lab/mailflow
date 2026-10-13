// Classification consumes T3 snapshots; these tests isolate persistence through the query spy.
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./spamModelStore.js', async importOriginal => ({ ...(await importOriginal()), getModelForUser: vi.fn() }));
vi.mock('../../fork-features/message-tags/index.js', async importOriginal => ({ ...(await importOriginal()), ensureMessageTags: vi.fn() }));
import { query } from './db.js';
import { getModelForUser } from './spamModelStore.js';
import { ensureMessageTags } from '../../fork-features/message-tags/index.js';
import { reputationUrlSubject } from '../../fork-features/reputation/index.js';
import { classifyAndTagMessage } from './spamPipeline.js';

const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const domain = 'fresh-offer.example';
const url = `https://${domain}/offer`;
const digest = reputationUrlSubject(url).urlDigest;
const checkedAt = '2026-10-12T00:00:00.000Z';
const complete = subjects => ({ kind: 'complete', checkedAt, subjects });
const inactive = { kind: 'inactive' };
function row(overrides = {}) {
  return {
    id: MESSAGE_ID, account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner_id: '11111111-1111-4111-8111-111111111111',
    antispam_enabled: true, master_spam_enabled: null, folder_mappings: {}, folder: 'INBOX', uid: 100,
    subject: 'Account notice', body_html: `<a href="${url}">www.cmbchina.com</a>`, body_text: null,
    from_email: 'notice@example.org', attachments: [], spam_user_override: null, ...overrides,
  };
}
const record = overrides => ({ rdap: inactive, spamhaus_dbl: inactive, urlhaus: inactive, safe_browsing: inactive, ...overrides });
const details = () => JSON.parse(query.mock.calls.find(([sql]) => sql.includes('UPDATE messages SET'))[1][2]);
async function classify(overrides = {}) {
  query.mockResolvedValueOnce({ rows: [row(overrides)] });
  return classifyAndTagMessage(MESSAGE_ID);
}
beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
  getModelForUser.mockReset().mockResolvedValue(null);
  ensureMessageTags.mockReset().mockResolvedValue(new Map([[MESSAGE_ID, record()]]));
});

describe('tag-backed link rules in classification', () => {
  it('persists all four fired link rules and the unchanged snapshots', async () => {
    const tags = record({
      rdap: complete({ [domain]: { kind: 'known', registeredAt: '2026-10-10T00:00:00.000Z' } }),
      spamhaus_dbl: complete({ [domain]: { kind: 'listed', detail: 'phishing' } }),
      safe_browsing: complete({ [digest]: { host: domain, verdict: { kind: 'listed', detail: 'SOCIAL_ENGINEERING' } } }),
    });
    ensureMessageTags.mockResolvedValue(new Map([[MESSAGE_ID, tags]]));
    await classify();
    expect(details().rulesFired).toEqual([
      { name: 'LINK_TEXT_DOMAIN_MISMATCH', weight: 0.5 }, { name: 'LINK_DOMAIN_NEW', weight: 0.4 },
      { name: 'LINK_DOMAIN_LISTED', weight: 0.6 }, { name: 'LINK_URL_UNSAFE', weight: 0.6 },
    ]);
    expect(details().links.tags).toEqual(tags);
    expect(details().links.flags).toEqual({ link_text_domain_mismatch: 1, link_domain_new: 1, link_domain_listed: 1, link_url_unsafe: 1 });
  });

  for (const state of [inactive, { kind: 'unconfigured' }, ...['plugin_failed', 'deadline', 'body_unavailable'].map(reason => ({ kind: 'unavailable', reason }))]) {
    it(`keeps ${state.kind}/${state.reason ?? ''} neutral in persisted verdict`, async () => {
      ensureMessageTags.mockResolvedValue(new Map([[MESSAGE_ID, record(Object.fromEntries(['rdap', 'spamhaus_dbl', 'urlhaus', 'safe_browsing'].map(source => [source, state])))]]));
      await classify({ body_html: `<a href="${url}">Open</a>` });
      expect(details().rulesFired).toEqual([]);
      expect(details().rulesScore).toBe(0);
      expect(details().links.flags).toEqual({ link_text_domain_mismatch: 0, link_domain_new: null, link_domain_listed: null, link_url_unsafe: null });
    });
  }

  it('leaves every flag unknown when the stored body is absent', async () => {
    await classify({ body_html: null });
    expect(details().rulesFired).toEqual([]);
    expect(details().links.flags).toEqual({ link_text_domain_mismatch: null, link_domain_new: null, link_domain_listed: null, link_url_unsafe: null });
    expect(ensureMessageTags).not.toHaveBeenCalled();
  });

  it('does not request tags with either anti-spam switch off', async () => {
    expect(await classify({ antispam_enabled: false })).toEqual({ skipped: 'antispam_disabled' });
    expect(await classify({ master_spam_enabled: 'false' })).toEqual({ skipped: 'spam_disabled' });
    expect(ensureMessageTags).not.toHaveBeenCalled();
  });
});
