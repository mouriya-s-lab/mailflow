import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStoredResultReader } from './index.js';

// This suite uses only connection-local tables and one rolled-back transaction. It exercises the
// reader against PostgreSQL's JSONB extraction, ownership predicates, aggregation, and keyset
// ordering rather than echoing SQL or replacing the database with a query mock.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('stored plugin results on PostgreSQL', () => {
  const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const OTHER_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ACCOUNT = '10000000-0000-4000-8000-000000000001';
  const SECOND_ACCOUNT = '10000000-0000-4000-8000-000000000002';
  const FOREIGN_ACCOUNT = '10000000-0000-4000-8000-000000000003';
  const DAY = 24 * 60 * 60 * 1000;
  const CHECKED_AT = '2026-10-13T00:00:00.000Z';
  const DECIDED_AT = '2026-10-14T00:00:00.000Z';
  const SAFE_DIGEST = 'a'.repeat(64);
  const SOURCE_PLUGINS = Object.freeze({
    rdap: 'owner-registration',
    spamhaus_dbl: 'owner-dbl',
    urlhaus: 'owner-url',
    safe_browsing: 'owner-safe',
  });
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const IDS = Object.freeze({
    spam: id(1), ham: id(2), uncertain: id(3), pending: id(4), retry: id(5), failed: id(6),
    disabled: id(7), malformedJev: id(8), missingJev: id(9), sameMessageFirst: id(10),
    sameMessageSecond: id(11), nullHam: id(12), deletedSpam: id(13), foreignSpam: id(14),
    secondAccountSpam: id(15),
    rdapMixed: id(20), rdapEmpty: id(21), rdapUnknown: id(22), malformedRdap: id(23),
    listingMixed: id(30), listingEmpty: id(31), listingUnknown: id(32), malformedListing: id(33),
    spamhausListed: id(34), safeBrowsingListed: id(35),
  });

  let client;
  let reader;

  const queue = (state = 'done', dueAt = null, origin = 'new_mail') => ({ state, dueAt, origin });
  const jevDone = (probability, training) => ({
    revision: 0,
    queue: queue(),
    category: null,
    spam: {
      decision: { kind: 'done', model: 'typesafe/jev', decidedAt: DECIDED_AT, probability },
      training: training === 'below_threshold'
        ? { kind: 'below_threshold' }
        : { kind: training, label: training === 'recorded' ? 'spam' : 'ham' },
    },
  });
  const jevPending = {
    revision: 0, queue: queue('pending'), category: null,
    spam: { decision: { kind: 'pending' }, training: { kind: 'blocked' } },
  };
  const jevRetry = {
    revision: 0,
    queue: queue('retry', '2026-10-15T00:00:00.000Z'),
    category: null,
    spam: {
      decision: { kind: 'retry', attempts: 1, errorKind: 'timeout', dueAt: '2026-10-15T00:00:00.000Z' },
      training: { kind: 'retry', label: 'spam', attempts: 1, dueAt: '2026-10-15T00:00:00.000Z' },
    },
  };
  const jevFailed = {
    revision: 0, queue: queue('terminal'), category: null,
    spam: {
      decision: { kind: 'terminal_failed', errorKind: 'invalid_response' },
      training: { kind: 'skipped', reason: 'decision_failed' },
    },
  };
  const jevDisabled = {
    revision: 0, queue: queue(), category: null,
    spam: {
      decision: { kind: 'skipped', reason: 'disabled' },
      training: { kind: 'skipped', reason: 'disabled' },
    },
  };
  const reputation = subjects => ({
    revision: 0,
    attempts: 0,
    queue: queue('done', null, 'backfill'),
    result: { kind: 'complete', checkedAt: CHECKED_AT, subjects },
  });
  const rdapMixed = reputation({
    'old.example': { kind: 'known', registeredAt: '2020-01-01T00:00:00.000Z' },
    'new.example': { kind: 'known', registeredAt: '2026-10-01T00:00:00.000Z' },
    'gone.example': { kind: 'not_found' },
    'unknown.example': { kind: 'unknown', reason: 'timeout' },
  });
  const urlhausMixed = reputation({
    'listed.example': { kind: 'listed', detail: 'malware' },
    'clean.example': { kind: 'not_listed' },
    'unknown.example': { kind: 'unknown', reason: 'timeout' },
  });
  const spamhausListed = reputation({
    'listed.example': { kind: 'listed', detail: 'phishing' },
  });
  const safeBrowsingListed = reputation({
    [SAFE_DIGEST]: { host: 'safe.example', verdict: { kind: 'listed', detail: 'social_engineering' } },
  });

  const annotation = (pluginId, value) => ({ [pluginId]: value });
  const addMessage = async ({
    id: messageId, accountId, uid, folder = 'INBOX', messageIdHeader = null,
    subject = 'Stored result fixture', fromName = 'Fixture Sender', fromEmail = 'sender@example.com',
    date = '2026-10-15T00:00:00.000Z', deleted = false, pluginAnnotations = {},
  }) => client.query(
    `INSERT INTO messages
       (id, account_id, uid, folder, message_id, subject, from_name, from_email, date, is_deleted, plugin_annotations)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [messageId, accountId, uid, folder, messageIdHeader, subject, fromName, fromEmail, date, deleted, JSON.stringify(pluginAnnotations)],
  );

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await client.connect();
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE email_accounts (
        id uuid PRIMARY KEY, user_id uuid NOT NULL, email_address text NOT NULL,
        name text, enabled boolean DEFAULT true
      );
      CREATE TEMP TABLE messages (
        id uuid PRIMARY KEY, account_id uuid NOT NULL, uid bigint NOT NULL, folder text NOT NULL,
        message_id text, subject text, from_name text, from_email text, date timestamptz,
        is_deleted boolean NOT NULL DEFAULT false, plugin_annotations jsonb NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    reader = createStoredResultReader({
      queryFn: (sql, params) => client.query(sql, params),
      tagSourcePluginsFn: () => SOURCE_PLUGINS,
    });
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE messages, email_accounts');
    await client.query(
      `INSERT INTO email_accounts (id, user_id, email_address, name) VALUES
       ($1,$2,$3,'Primary'), ($4,$2,$5,'Second'), ($6,$7,$8,'Foreign')`,
      [ACCOUNT, OWNER, 'owner@example.com', SECOND_ACCOUNT, 'second@example.com', FOREIGN_ACCOUNT, OTHER_USER, 'foreign@example.com'],
    );

    await addMessage({ id: IDS.spam, accountId: ACCOUNT, uid: 1, date: '2026-10-15T12:00:00.000Z', subject: 'Boundary spam', messageIdHeader: '<spam@example.com>', pluginAnnotations: annotation('jev-classify', jevDone(0.9, 'recorded')) });
    await addMessage({ id: IDS.ham, accountId: ACCOUNT, uid: 2, date: '2026-10-15T11:00:00.000Z', subject: 'Boundary ham', messageIdHeader: '<ham@example.com>', pluginAnnotations: annotation('jev-classify', { ...jevDone(0.1, 'duplicate'), spam: { ...jevDone(0.1, 'duplicate').spam, training: { kind: 'duplicate', label: 'ham' } } }) });
    await addMessage({ id: IDS.uncertain, accountId: ACCOUNT, uid: 3, date: '2026-10-15T10:00:00.000Z', subject: 'Middle probability', pluginAnnotations: annotation('jev-classify', jevDone(0.5, 'below_threshold')) });
    await addMessage({ id: IDS.pending, accountId: ACCOUNT, uid: 4, date: '2026-10-15T09:00:00.000Z', subject: 'Pending decision', pluginAnnotations: annotation('jev-classify', jevPending) });
    await addMessage({ id: IDS.retry, accountId: ACCOUNT, uid: 5, date: '2026-10-15T08:00:00.000Z', subject: 'Retry decision', pluginAnnotations: annotation('jev-classify', jevRetry) });
    await addMessage({ id: IDS.failed, accountId: ACCOUNT, uid: 6, date: '2026-10-15T07:00:00.000Z', subject: 'Failed decision', pluginAnnotations: annotation('jev-classify', jevFailed) });
    await addMessage({ id: IDS.disabled, accountId: ACCOUNT, uid: 7, date: '2026-10-15T06:00:00.000Z', subject: 'Disabled decision', pluginAnnotations: annotation('jev-classify', jevDisabled) });
    await addMessage({ id: IDS.malformedJev, accountId: ACCOUNT, uid: 8, date: '2026-10-15T05:00:00.000Z', subject: 'Malformed Jev', pluginAnnotations: annotation('jev-classify', jevDone(2, 'below_threshold')) });
    await addMessage({ id: IDS.missingJev, accountId: ACCOUNT, uid: 9, date: '2026-10-15T04:00:00.000Z', subject: 'No Jev result' });
    await addMessage({ id: IDS.sameMessageFirst, accountId: ACCOUNT, uid: 10, date: '2026-10-15T03:00:00.000Z', subject: 'Same Message-ID first', messageIdHeader: '<same@example.com>', pluginAnnotations: annotation('jev-classify', jevDone(0.9, 'recorded')) });
    await addMessage({ id: IDS.sameMessageSecond, accountId: ACCOUNT, uid: 11, date: '2026-10-15T03:00:00.000Z', subject: 'Same Message-ID second', messageIdHeader: '<same@example.com>', pluginAnnotations: annotation('jev-classify', jevDone(0.9, 'recorded')) });
    await addMessage({ id: IDS.nullHam, accountId: ACCOUNT, uid: 12, date: null, subject: null, fromName: null, fromEmail: null, pluginAnnotations: annotation('jev-classify', { ...jevDone(0.1, 'duplicate'), spam: { ...jevDone(0.1, 'duplicate').spam, training: { kind: 'duplicate', label: 'ham' } } }) });
    await addMessage({ id: IDS.deletedSpam, accountId: ACCOUNT, uid: 13, date: '2026-10-15T13:00:00.000Z', subject: 'Deleted spam', deleted: true, pluginAnnotations: annotation('jev-classify', jevDone(0.9, 'recorded')) });
    await addMessage({ id: IDS.foreignSpam, accountId: FOREIGN_ACCOUNT, uid: 14, date: '2026-10-15T14:00:00.000Z', subject: 'Foreign spam', pluginAnnotations: annotation('jev-classify', jevDone(0.9, 'recorded')) });
    await addMessage({ id: IDS.secondAccountSpam, accountId: SECOND_ACCOUNT, uid: 15, date: '2026-10-15T15:00:00.000Z', subject: 'Second account spam', pluginAnnotations: annotation('jev-classify', jevDone(0.9, 'recorded')) });

    await addMessage({ id: IDS.rdapMixed, accountId: ACCOUNT, uid: 20, folder: 'Archive', date: '2026-10-14T12:00:00.000Z', subject: 'RDAP mixed subjects', fromName: 'RDAP Sender', fromEmail: 'rdap@example.com', pluginAnnotations: annotation(SOURCE_PLUGINS.rdap, rdapMixed) });
    await addMessage({ id: IDS.rdapEmpty, accountId: ACCOUNT, uid: 21, date: '2026-10-14T11:00:00.000Z', subject: 'RDAP no links', pluginAnnotations: annotation(SOURCE_PLUGINS.rdap, reputation({})) });
    await addMessage({ id: IDS.rdapUnknown, accountId: ACCOUNT, uid: 22, date: '2026-10-14T10:00:00.000Z', subject: 'RDAP unknown', pluginAnnotations: annotation(SOURCE_PLUGINS.rdap, reputation({ 'unknown.example': { kind: 'unknown', reason: 'rate_limited' } })) });
    await addMessage({ id: IDS.malformedRdap, accountId: ACCOUNT, uid: 23, date: '2026-10-14T09:00:00.000Z', subject: 'Malformed RDAP', pluginAnnotations: annotation(SOURCE_PLUGINS.rdap, { revision: 0, queue: queue(), result: { kind: 'complete', checkedAt: 'not-a-time', subjects: {} } }) });

    await addMessage({ id: IDS.listingMixed, accountId: ACCOUNT, uid: 30, date: '2026-10-13T12:00:00.000Z', subject: 'URLhaus mixed subjects', pluginAnnotations: annotation(SOURCE_PLUGINS.urlhaus, urlhausMixed) });
    await addMessage({ id: IDS.listingEmpty, accountId: ACCOUNT, uid: 31, date: '2026-10-13T11:00:00.000Z', subject: 'URLhaus no links', pluginAnnotations: annotation(SOURCE_PLUGINS.urlhaus, reputation({})) });
    await addMessage({ id: IDS.listingUnknown, accountId: ACCOUNT, uid: 32, date: '2026-10-13T10:00:00.000Z', subject: 'URLhaus unknown', pluginAnnotations: annotation(SOURCE_PLUGINS.urlhaus, reputation({ 'unknown.example': { kind: 'unknown', reason: 'error' } })) });
    await addMessage({ id: IDS.malformedListing, accountId: ACCOUNT, uid: 33, date: '2026-10-13T09:00:00.000Z', subject: 'Malformed URLhaus', pluginAnnotations: annotation(SOURCE_PLUGINS.urlhaus, { revision: 0, queue: queue(), result: { kind: 'complete', checkedAt: 'bad', subjects: {} } }) });
    await addMessage({ id: IDS.spamhausListed, accountId: ACCOUNT, uid: 34, date: '2026-10-13T08:00:00.000Z', subject: 'Spamhaus listed', pluginAnnotations: annotation(SOURCE_PLUGINS.spamhaus_dbl, spamhausListed) });
    await addMessage({ id: IDS.safeBrowsingListed, accountId: ACCOUNT, uid: 35, date: '2026-10-13T07:00:00.000Z', subject: 'Safe Browsing listed', pluginAnnotations: annotation(SOURCE_PLUGINS.safe_browsing, safeBrowsingListed) });
  });

  const jevResults = input => reader.readJevSpamResults(OWNER, { hamAtMost: 0.1, spamAtLeast: 0.9 }, input);
  const accountJevResults = input => jevResults({ ...input, accountId: ACCOUNT });
  const rdapResults = input => reader.readReputationResults(OWNER, { source: 'rdap', newDomainMaxAgeMs: 30 * DAY }, input);
  const listingResults = (source, input) => reader.readReputationResults(OWNER, { source, newDomainMaxAgeMs: 30 * DAY }, input);
  const ids = page => page.messages.map(message => message.id);
  const countOf = (page, facet) => {
    const count = page.counts.find(entry => entry.facet === facet);
    expect(count).toBeDefined();
    return count.count;
  };
  const expectFacet = async (read, facet, expectedIds) => {
    const page = await read({ facet, limit: '200' });
    expect(page.kind).toBe('ok');
    expect(page.observedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(page.observedAt))).toBe(false);
    expect(ids(page)).toEqual(expect.arrayContaining(expectedIds));
    expect(countOf(page, facet)).toBe(expectedIds.length);
    expect(ids(page)).toHaveLength(expectedIds.length);
    return page;
  };

  it('uses the owner threshold boundaries and keeps middle probabilities uncertain', async () => {
    const spam = await expectFacet(accountJevResults, 'spam', [IDS.spam, IDS.sameMessageFirst, IDS.sameMessageSecond]);
    const ham = await expectFacet(accountJevResults, 'ham', [IDS.ham, IDS.nullHam]);
    const uncertain = await expectFacet(accountJevResults, 'uncertain', [IDS.uncertain]);
    expect(spam.accounts.map(account => account.id).sort()).toEqual([ACCOUNT, SECOND_ACCOUNT].sort());

    expect(spam.messages[0]).toMatchObject({
      id: IDS.spam, accountId: ACCOUNT, accountEmail: 'owner@example.com', folder: 'INBOX', uid: 1,
      subject: 'Boundary spam', fromName: 'Fixture Sender', fromEmail: 'sender@example.com',
      date: '2026-10-15T12:00:00.000Z', facets: expect.arrayContaining(['spam']),
      annotation: {
        revision: 0,
        spam: { decision: { kind: 'done', probability: 0.9, model: 'typesafe/jev', decidedAt: DECIDED_AT } },
      },
    });
    expect(ham.messages[0].annotation.spam.decision.probability).toBe(0.1);
    expect(ham.messages.at(-1)).toMatchObject({ subject: null, fromName: null, fromEmail: null, date: null });
    expect(uncertain.messages[0].annotation.spam.decision.probability).toBe(0.5);
  });

  it('keeps missing, incomplete, disabled, and malformed stored Jev states distinct', async () => {
    for (const [facet, expected] of [
      ['pending', IDS.pending], ['retry', IDS.retry], ['failed', IDS.failed], ['disabled', IDS.disabled],
      ['unrecognized', IDS.malformedJev],
    ]) {
      const page = await expectFacet(jevResults, facet, [expected]);
      expect(page.messages[0].facets).toContain(facet);
      expect(page.messages[0].annotation).toEqual(expect.any(Object));
    }
    const notChecked = await jevResults({ facet: 'not_checked', limit: '200' });
    expect(notChecked.kind).toBe('ok');
    for (const id of [IDS.missingJev, IDS.malformedJev, IDS.pending, IDS.retry, IDS.failed, IDS.disabled]) {
      expect(ids(notChecked)).toContain(id);
    }
    expect(ids(notChecked)).not.toContain(IDS.spam);
    expect(ids(notChecked)).not.toContain(IDS.ham);
    const checked = await jevResults({ accountId: ACCOUNT, facet: 'checked', limit: '200' });
    expect(ids(checked)).toEqual(expect.arrayContaining([IDS.spam, IDS.ham, IDS.uncertain, IDS.sameMessageFirst, IDS.sameMessageSecond]));
    expect(ids(checked)).not.toContain(IDS.pending);
    expect(ids(checked)).not.toContain(IDS.malformedJev);
    expect(ids(notChecked)).not.toContain(IDS.uncertain);
  });

  it('counts live physical rows, not Message-ID values, and enforces user/account ownership', async () => {
    const all = await jevResults({ facet: 'all', limit: '200' });
    expect(all.kind).toBe('ok');
    expect(ids(all)).toContain(IDS.sameMessageFirst);
    expect(ids(all)).toContain(IDS.sameMessageSecond);
    expect(ids(all)).toContain(IDS.missingJev);
    expect(ids(all)).toContain(IDS.malformedJev);
    expect(ids(all)).not.toContain(IDS.deletedSpam);
    expect(ids(all)).not.toContain(IDS.foreignSpam);
    expect(ids(all)).toContain(IDS.secondAccountSpam);

    const account = await jevResults({ accountId: ACCOUNT, facet: 'spam', limit: '200' });
    expect(ids(account)).not.toContain(IDS.secondAccountSpam);
    expect(countOf(account, 'spam')).toBe(3);
    const second = await jevResults({ accountId: SECOND_ACCOUNT, facet: 'spam', limit: '200' });
    expect(ids(second)).toEqual([IDS.secondAccountSpam]);
    expect(await jevResults({ accountId: FOREIGN_ACCOUNT, facet: 'spam', limit: '200' })).toMatchObject({ kind: 'not_found' });
  });

  it('orders date ties by UUID, puts NULL dates last, and keyset pages without overlap', async () => {
    const first = await accountJevResults({ facet: 'spam', limit: '2' });
    expect(first.kind).toBe('ok');
    expect(ids(first)).toEqual([IDS.spam, IDS.sameMessageSecond]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await accountJevResults({ facet: 'spam', limit: '2', cursor: first.nextCursor });
    expect(second.kind).toBe('ok');
    expect(ids(second)).toEqual([IDS.sameMessageFirst]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(3);

    const ham = await accountJevResults({ facet: 'ham', limit: '200' });
    expect(ids(ham).at(-1)).toBe(IDS.nullHam);
    expect(await accountJevResults({ facet: 'ham', cursor: first.nextCursor })).toMatchObject({ kind: 'invalid' });
    expect(await jevResults({ accountId: SECOND_ACCOUNT, facet: 'spam', cursor: first.nextCursor })).toMatchObject({ kind: 'invalid' });
  });

  it('rejects invalid filters and returns exact physical details only to the owner', async () => {
    expect(await jevResults({ facet: 'not-a-facet' })).toMatchObject({ kind: 'invalid' });
    expect(await jevResults({ limit: '0' })).toMatchObject({ kind: 'invalid' });

    const detail = await reader.readJevSpamMessage(OWNER, { hamAtMost: 0.1, spamAtLeast: 0.9 }, IDS.sameMessageFirst);
    expect(detail.kind).toBe('ok');
    expect(detail.observedAt).toEqual(expect.any(String));
    expect(detail.message.id).toBe(IDS.sameMessageFirst);
    expect(detail.message.subject).toBe('Same Message-ID first');
    expect(await reader.readJevSpamMessage(OWNER, { hamAtMost: 0.1, spamAtLeast: 0.9 }, IDS.foreignSpam)).toEqual({ kind: 'not_found' });
    expect(await reader.readJevSpamMessage(OWNER, { hamAtMost: 0.1, spamAtLeast: 0.9 }, IDS.deletedSpam)).toEqual({ kind: 'not_found' });
  });

  it('deduplicates each RDAP facet per message while retaining overlapping facets', async () => {
    const mixed = await expectFacet(rdapResults, 'registered', [IDS.rdapMixed]);
    await expectFacet(rdapResults, 'new_domain', [IDS.rdapMixed]);
    await expectFacet(rdapResults, 'not_found', [IDS.rdapMixed]);
    await expectFacet(rdapResults, 'unknown', [IDS.rdapMixed, IDS.rdapUnknown]);
    await expectFacet(rdapResults, 'no_links', [IDS.rdapEmpty]);
    await expectFacet(rdapResults, 'unrecognized', [IDS.malformedRdap]);
    const missing = await rdapResults({ facet: 'not_checked', limit: '200' });
    expect(ids(missing)).toContain(IDS.missingJev);
    expect(ids(missing)).toContain(IDS.malformedRdap);
    expect(ids(missing)).not.toContain(IDS.rdapEmpty);
    expect(ids(missing)).not.toContain(IDS.rdapMixed);

    const row = mixed.messages[0];
    expect(row.facets.filter(facet => facet === 'registered')).toHaveLength(1);
    expect(row.facets).toEqual(expect.arrayContaining(['registered', 'new_domain', 'not_found', 'unknown']));
    expect(row.annotation).toMatchObject({
      revision: 0,
      result: {
        kind: 'complete', checkedAt: CHECKED_AT,
        subjects: {
          'old.example': { kind: 'known', registeredAt: '2020-01-01T00:00:00.000Z' },
          'new.example': { kind: 'known', registeredAt: '2026-10-01T00:00:00.000Z' },
          'gone.example': { kind: 'not_found' },
          'unknown.example': { kind: 'unknown', reason: 'timeout' },
        },
      },
    });
  });

  it.each([
    ['spamhaus_dbl', IDS.spamhausListed, 'listed.example'],
    ['urlhaus', IDS.listingMixed, 'listed.example'],
    ['safe_browsing', IDS.safeBrowsingListed, SAFE_DIGEST],
  ])('uses the registered %s owner and listing facets', async (source, expectedId, expectedSubject) => {
    const listed = await expectFacet(input => listingResults(source, input), 'listed', [expectedId]);
    const row = listed.messages[0];
    expect(row.annotation).toMatchObject({ revision: 0, result: { kind: 'complete', checkedAt: CHECKED_AT } });
    expect(row.annotation.result.subjects).toHaveProperty(expectedSubject);
    expect(row.annotation.result.subjects[expectedSubject]).toMatchObject(source === 'safe_browsing'
      ? { host: 'safe.example', verdict: { kind: 'listed', detail: 'social_engineering' } }
      : { kind: 'listed' });
  });

  it('keeps empty, unknown, malformed, and not-checked listing snapshots separate', async () => {
    const clearId = id(36);
    await addMessage({
      id: clearId, accountId: ACCOUNT, uid: 36,
      pluginAnnotations: annotation(SOURCE_PLUGINS.urlhaus, reputation({ 'clear.example': { kind: 'not_listed' } })),
    });
    const listing = input => listingResults('urlhaus', input);
    await expectFacet(listing, 'listed', [IDS.listingMixed]);
    await expectFacet(listing, 'not_listed', [clearId]);
    await expectFacet(listing, 'unknown', [IDS.listingMixed, IDS.listingUnknown]);
    await expectFacet(listing, 'no_links', [IDS.listingEmpty]);
    await expectFacet(listing, 'unrecognized', [IDS.malformedListing]);
    const missing = await listing({ facet: 'not_checked', limit: '200' });
    expect(ids(missing)).toContain(IDS.missingJev);
    expect(ids(missing)).toContain(IDS.malformedListing);
    expect(ids(missing)).not.toContain(IDS.listingEmpty);
  });

  it('returns exact reputation details and applies account ownership to details', async () => {
    const detail = await reader.readReputationMessage(OWNER, { source: 'rdap', newDomainMaxAgeMs: 30 * DAY }, IDS.rdapMixed);
    expect(detail.kind).toBe('ok');
    expect(detail.observedAt).toEqual(expect.any(String));
    expect(detail.message.id).toBe(IDS.rdapMixed);
    expect(detail.message.accountId).toBe(ACCOUNT);
    expect(detail.message.annotation).toMatchObject({ revision: 0, result: { kind: 'complete', checkedAt: CHECKED_AT } });
    const noResult = await reader.readReputationMessage(OWNER, { source: 'urlhaus', newDomainMaxAgeMs: 30 * DAY }, IDS.rdapMixed);
    expect(noResult.kind).toBe('ok');
    expect(noResult.message.annotation).toBeNull();
    expect(noResult.message.facets).toContain('not_checked');
    expect(await reader.readReputationMessage(OWNER, { source: 'rdap', newDomainMaxAgeMs: 30 * DAY }, IDS.foreignSpam)).toEqual({ kind: 'not_found' });
    expect(await reader.readReputationMessage(OWNER, { source: 'rdap', newDomainMaxAgeMs: 30 * DAY }, IDS.deletedSpam)).toEqual({ kind: 'not_found' });
    expect(await rdapResults({ facet: 'bad' })).toMatchObject({ kind: 'invalid' });
  });

  it('keeps facet counts equal to their filtered physical result sets', async () => {
    for (const [read, facets] of [
      [jevResults, ['spam', 'ham', 'uncertain', 'pending', 'retry', 'failed', 'disabled', 'unrecognized', 'not_checked']],
      [rdapResults, ['registered', 'new_domain', 'not_found', 'unknown', 'no_links', 'unrecognized', 'not_checked']],
      [input => listingResults('urlhaus', input), ['listed', 'not_listed', 'unknown', 'no_links', 'unrecognized', 'not_checked']],
    ]) {
      for (const facet of facets) {
        const page = await read({ facet, limit: '200' });
        expect(page.kind).toBe('ok');
        expect(countOf(page, facet)).toBe(page.messages.length);
      }
    }
  });
});
