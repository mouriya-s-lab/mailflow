import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReputation } from './index.js';

// The migration and the cache statements against a real PostgreSQL. Everything runs inside one
// transaction that is rolled back, so the supplied database is left as it was.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('fork_reputation_cache on PostgreSQL', () => {
  const START = Date.parse('2026-10-12T08:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  let client;
  let clock;
  let requested;
  let rep;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await client.connect();
    await client.query('BEGIN');
    await client.query(readFileSync(new URL('../../migrations/9002_fork_reputation_cache.sql', import.meta.url), 'utf8'));
    clock = START;
    requested = [];
    rep = createReputation({
      queryFn: (sql, params) => client.query(sql, params),
      getConfigFn: async () => ({ rdapEnabled: true, spamhausDqsKey: null, urlhausAuthKey: null, safeBrowsingApiKey: null }),
      fetchFn: async url => {
        requested.push(url);
        if (url.endsWith('/dns.json')) return new Response(JSON.stringify({ services: [[['com'], ['https://rdap.registry.test/']]] }));
        if (url.endsWith('/gone.com')) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '1997-04-28T04:00:00Z' }] }));
      },
      now: () => clock,
    });
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  const rows = async () => (await client.query(
    'SELECT source, subject, result, fetched_at, expires_at FROM fork_reputation_cache ORDER BY subject',
  )).rows;

  it('stores answers with their lifetimes, serves them back, and overwrites an expired row', async () => {
    const first = await rep.lookupDomains(['old.com', 'gone.com'], { deadlineMs: 5000 });
    expect(first.get('old.com').registration).toEqual({ kind: 'known', registeredAt: '1997-04-28T04:00:00.000Z' });
    expect(first.get('gone.com').registration).toEqual({ kind: 'not_found' });
    expect(await rows()).toEqual([
      { source: 'rdap', subject: 'gone.com', result: { kind: 'not_found' }, fetched_at: new Date(START), expires_at: new Date(START + DAY) },
      {
        source: 'rdap', subject: 'old.com', result: { kind: 'known', registeredAt: '1997-04-28T04:00:00.000Z' },
        fetched_at: new Date(START), expires_at: new Date(START + 30 * DAY),
      },
    ]);

    clock = START + 60 * 60 * 1000;
    const before = requested.length;
    const second = await rep.lookupDomains(['old.com', 'gone.com'], { deadlineMs: 5000 });
    expect(requested.length).toBe(before);
    expect(second).toEqual(first);

    clock = START + DAY + 1;
    await rep.lookupDomains(['gone.com'], { deadlineMs: 5000 });
    expect(requested.at(-1)).toBe('https://rdap.registry.test/domain/gone.com');
    const gone = (await rows()).find(r => r.subject === 'gone.com');
    expect(gone).toMatchObject({ fetched_at: new Date(START + DAY + 1), expires_at: new Date(START + 2 * DAY + 1) });
  });
});
