import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../../src/services/db.js', () => ({ query: vi.fn() }));
import { query } from '../../src/services/db.js';
import { setMessageAnnotation } from '../../src/services/mailAccess.js';
import { countQueued, currentUidFloors, listQueuedMessages, markMessages } from './index.js';

const accountId = '22222222-2222-4222-8222-222222222222';
const otherAccountId = '33333333-3333-4333-8333-333333333333';
const pluginId = 'queue-test';
const now = new Date('2026-10-12T12:00:00Z');
const date = new Date('2026-10-11T12:00:00Z');
const syncedAt = new Date('2026-10-12T10:00:00Z');
const queued = (state, origin = 'backfill', dueAt = null) => ({
  revision: 2, queue: { state, dueAt, origin },
});
const markArgs = (overrides = {}) => ({
  accountId, pluginId, scope: { kind: 'not_at_revision' }, revision: 2,
  origin: 'backfill', limit: 100, ...overrides,
});

// The usual cases use connection-local tables only. The lock-recheck case needs two
// connections to the same row, so it alone uses an isolated, disposable schema.
const tableDefinitions = (temporary = false) => {
  const prefix = temporary ? 'CREATE TEMP TABLE' : 'CREATE TABLE';
  return `
    ${prefix} email_accounts (id uuid, folder_mappings jsonb);
    ${prefix} folders (account_id uuid, path text, name text, delimiter text,
      special_use text, no_select boolean DEFAULT false, uid_validity bigint,
      UNIQUE(account_id, path));
    ${prefix} messages (id uuid PRIMARY KEY, account_id uuid, folder text, uid bigint,
      message_id text, date timestamptz, synced_at timestamptz DEFAULT now(),
      is_deleted boolean DEFAULT false, plugin_annotations jsonb NOT NULL DEFAULT '{}',
      UNIQUE(account_id, uid, folder));`;
};

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('plugin work queue PostgreSQL', () => {
  let database, markingClient, writingClient, concurrencySchema;

  beforeAll(async () => {
    const connectionString = process.env.MAILFLOW_TEST_DATABASE_URL;
    database = new pg.Client({ connectionString });
    await database.connect();
    await database.query(tableDefinitions(true));
    markingClient = new pg.Client({ connectionString });
    writingClient = new pg.Client({ connectionString });
    await markingClient.connect();
    await writingClient.connect();
    concurrencySchema = `iss13_conc_${randomUUID().replaceAll('-', '')}`;
    await database.query(`CREATE SCHEMA ${concurrencySchema}`);
    await markingClient.query(`SET search_path TO ${concurrencySchema}`);
    await writingClient.query(`SET search_path TO ${concurrencySchema}`);
    await markingClient.query(tableDefinitions());
  });

  afterAll(async () => {
    await writingClient?.end();
    await markingClient?.end();
    if (concurrencySchema) await database.query(`DROP SCHEMA ${concurrencySchema} CASCADE`);
    await database?.end();
  });

  beforeEach(async () => {
    query.mockImplementation((sql, values) => database.query(sql, values));
    await database.query('TRUNCATE messages, folders, email_accounts');
    await database.query('INSERT INTO email_accounts(id) VALUES ($1), ($2)', [accountId, otherAccountId]);
  });

  const folder = (path, { uidValidity = 42, specialUse = null, name = path, noSelect = false } = {}) => database.query(
    `INSERT INTO folders(account_id, path, name, delimiter, special_use, no_select, uid_validity)
     VALUES ($1, $2, $3, '/', $4, $5, $6)`,
    [accountId, path, name, specialUse, noSelect, uidValidity],
  );

  const insert = async ({ uid, folder: path = 'INBOX', annotations = {}, deleted = false,
    account = accountId, client = database } = {}) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO messages(id, account_id, folder, uid, message_id, date, synced_at, is_deleted, plugin_annotations)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, account, path, uid, `<${id}@test.example>`, date, syncedAt, deleted, JSON.stringify(annotations)],
    );
    return id;
  };

  const annotationsById = async () => {
    const { rows } = await database.query('SELECT id, plugin_annotations FROM messages');
    return Object.fromEntries(rows.map(row => [row.id, row.plugin_annotations]));
  };

  const specialFolders = async (mappedSent = false) => {
    const sent = mappedSent ? 'Outbox/Delivered' : 'Sent';
    await folder(sent, { specialUse: mappedSent ? null : '\\Sent' });
    await folder('Composition', { specialUse: '\\Drafts' });
    await folder('Discarded', { specialUse: '\\Trash' });
    await folder('INBOX/Draft', { name: 'Draft' });
    if (mappedSent) {
      await database.query('UPDATE email_accounts SET folder_mappings = $2 WHERE id = $1',
        [accountId, JSON.stringify({ sent })]);
    }
    return [sent, 'Composition', 'Discarded', 'INBOX/Draft'];
  };

  it('lists only pending and due retry rows in due order and counts each origin independently (row 1b)', async () => {
    const states = [
      queued('pending'),
      queued('retry', 'backfill', '2026-10-12T11:00:00Z'),
      queued('retry', 'backfill', '2026-10-12T13:00:00Z'),
      queued('done'),
      queued('terminal'),
    ];
    const ids = [];
    for (const [index, annotation] of states.entries()) {
      ids.push(await insert({ uid: index + 1, annotations: { [pluginId]: annotation, other: { secret: 'not returned' } } }));
    }
    await insert({ uid: 6, annotations: { [pluginId]: queued('done', 'new_mail') } });
    await insert({ uid: 7, annotations: { [pluginId]: queued('done', 'new_mail') } });
    await insert({ uid: 8, annotations: { [pluginId]: queued('terminal', 'new_mail') } });
    await insert({ uid: 9, annotations: { other: queued('pending') } });
    await insert({ uid: 1, account: otherAccountId, annotations: { [pluginId]: queued('pending') } });

    const rows = await listQueuedMessages({ accountId, pluginId, now, limit: 100 });
    expect(rows).toEqual([0, 1].map(index => ({
      id: ids[index], folder: 'INBOX', uid: String(index + 1),
      message_id: `<${ids[index]}@test.example>`, date, synced_at: syncedAt,
      plugin_annotation: states[index],
    })));
    expect(await countQueued({ accountId, pluginId, origin: 'backfill' })).toEqual({
      pending: 1, retry: 2, done: 1, terminal: 1,
    });
    expect(await countQueued({ accountId, pluginId, origin: 'new_mail' })).toEqual({
      pending: 0, retry: 0, done: 2, terminal: 1,
    });
  });

  it('caps the queue list at 200 actual rows even when the requested limit is larger (row 1b)', async () => {
    await database.query(
      `INSERT INTO messages(id, account_id, folder, uid, plugin_annotations)
       SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, $1, 'INBOX', n, $2::jsonb
       FROM generate_series(1, 201) AS n`,
      [accountId, JSON.stringify({ [pluginId]: queued('pending') })],
    );
    const rows = await listQueuedMessages({ accountId, pluginId, now, limit: 1000 });
    expect(rows).toHaveLength(200);
    expect(rows[199].uid).toBe('200');
    expect(await countQueued({ accountId, pluginId, origin: 'backfill' })).toEqual({
      pending: 201, retry: 0, done: 0, terminal: 0,
    });
    expect(await listQueuedMessages({ accountId, pluginId, now, limit: 3 })).toHaveLength(3);
  });

  for (const mappedSent of [false, true]) {
    const exclusion = mappedSent ? 'mapped Sent and special-use Drafts/Trash' : 'special-use Sent/Drafts/Trash';
    it(`takes numeric UID floors, excludes ${exclusion}, and rejects changed UIDVALIDITY (row 2)`, async () => {
      await folder('INBOX', { uidValidity: 77 });
      await folder('Projects', { uidValidity: 88 });
      await folder('Unknown', { uidValidity: null });
      await folder('Empty', { uidValidity: 99 });
      const excluded = await specialFolders(mappedSent);
      await insert({ uid: 5 });
      await insert({ uid: 10 });
      await insert({ uid: 30, folder: 'Projects' });
      await insert({ uid: 500, folder: 'Unknown' });
      for (const path of excluded) await insert({ uid: 500, folder: path });
      await insert({ uid: 900, account: otherAccountId });

      const floors = await currentUidFloors({ accountId });
      expect(floors).toEqual({
        INBOX: { uidValidity: 77, nextUid: 11 },
        Projects: { uidValidity: 88, nextUid: 31 },
        Empty: { uidValidity: 99, nextUid: 1 },
      });
      const newIds = [await insert({ uid: 11 }), await insert({ uid: 12 })];
      const below = await insert({ uid: 9 });
      const scope = { kind: 'above_uid_floor', floors };
      expect(await markMessages(markArgs({ scope, origin: 'new_mail' }))).toBe(2);
      const annotations = await annotationsById();
      expect(Object.entries(annotations).filter(([, value]) => value[pluginId]).map(([id]) => id).sort()).toEqual(newIds.sort());
      for (const id of newIds) expect(annotations[id][pluginId]).toEqual(queued('pending', 'new_mail'));
      expect(annotations[below]).toEqual({});

      await database.query("UPDATE folders SET uid_validity = 78 WHERE account_id = $1 AND path = 'INBOX'", [accountId]);
      const afterReset = await insert({ uid: 13 });
      expect(await markMessages(markArgs({ scope, origin: 'new_mail' }))).toBe(0);
      expect((await annotationsById())[afterReset]).toEqual({});
    });

    it(`marks only processable old revisions, preserves namespaces, and batches around ${exclusion} (row 1)`, async () => {
      const excluded = await specialFolders(mappedSent);
      const custom = await insert({ uid: 1, annotations: { [pluginId]: { revision: 1, custom: 'keep' }, other: { untouched: true } } });
      const absent = await insert({ uid: 2 });
      const more = await insert({ uid: 3 });
      const unchanged = { [pluginId]: queued('done'), other: { untouched: true } };
      const current = await insert({ uid: 4, annotations: unchanged });
      const deleted = await insert({ uid: 5, deleted: true });
      const foreign = await insert({ uid: 1, account: otherAccountId });
      const excludedIds = [];
      for (const path of excluded) excludedIds.push(await insert({ uid: 1, folder: path }));

      expect(await markMessages(markArgs({ limit: 2 }))).toBe(2);
      const first = await annotationsById();
      const writtenIds = Object.entries(first).filter(([, value]) => value[pluginId]?.queue?.state === 'pending').map(([id]) => id);
      expect(writtenIds).toHaveLength(2);
      expect(writtenIds.every(id => [custom, absent, more].includes(id))).toBe(true);
      expect(await markMessages(markArgs({ limit: 2 }))).toBe(1);
      const final = await annotationsById();
      expect(final[custom]).toEqual({ [pluginId]: { ...queued('pending'), custom: 'keep' }, other: { untouched: true } });
      expect(final[absent]).toEqual({ [pluginId]: queued('pending') });
      expect(final[more]).toEqual({ [pluginId]: queued('pending') });
      expect(final[current]).toEqual(unchanged);
      for (const id of [...excludedIds, deleted, foreign]) expect(final[id]).toEqual({});
      expect(await markMessages(markArgs({ limit: 2 }))).toBe(0);
    });
  }

  it('rechecks revision after a concurrent writer commits and does not overwrite its done queue (atomicity)', async () => {
    await markingClient.query('TRUNCATE messages, folders, email_accounts');
    await markingClient.query('INSERT INTO email_accounts(id) VALUES ($1)', [accountId]);
    const id = await insert({ uid: 1, client: markingClient, annotations: { [pluginId]: { revision: 1 } } });
    const completed = queued('done');
    await writingClient.query('BEGIN');
    let marking;
    try {
      await writingClient.query('UPDATE messages SET plugin_annotations = $2 WHERE id = $1',
        [id, JSON.stringify({ [pluginId]: completed })]);
      query.mockImplementation((sql, values) => markingClient.query(sql, values));
      marking = markMessages(markArgs());
      // Observe the actual blocked UPDATE, rather than assuming scheduling from a sleep.
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const { rows: [activity] } = await database.query(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [markingClient.processID]);
        if (activity?.wait_event_type === 'Lock') {
          waiting = true;
          break;
        }
        await delay(20);
      }
      expect(waiting, 'markMessages must reach the row lock before the concurrent commit').toBe(true);
      await writingClient.query('COMMIT');
      expect(await marking).toBe(0);
      const { rows: [row] } = await markingClient.query('SELECT plugin_annotations FROM messages WHERE id = $1', [id]);
      expect(row.plugin_annotations).toEqual({ [pluginId]: completed });
    } finally {
      await writingClient.query('ROLLBACK');
      if (marking) await marking;
      query.mockImplementation((sql, values) => database.query(sql, values));
    }
  }, 10000);

  it.each([
    ['invalid scope kind', { scope: { kind: 'all' } }],
    ['non-integer revision', { revision: 1.5 }],
    ['unknown origin', { origin: 'import' }],
    ['zero limit', { limit: 0 }],
  ])('rejects %s at the mark boundary', async (_name, overrides) => {
    await expect(markMessages(markArgs(overrides))).rejects.toThrow(TypeError);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM messages')).rows[0].count).toBe(0);
  });

  it('rejects zero list limits and unknown count origins', async () => {
    await expect(listQueuedMessages({ accountId, pluginId, now, limit: 0 })).rejects.toThrow(TypeError);
    await expect(countQueued({ accountId, pluginId, origin: 'unknown' })).rejects.toThrow(TypeError);
  });

  it('fails loudly when a stored annotation has an unknown queue state', async () => {
    await insert({ uid: 1, annotations: { [pluginId]: queued('mystery') } });
    await expect(countQueued({ accountId, pluginId, origin: 'backfill' })).rejects.toThrow(/queue state "mystery" outside pending\|retry\|done\|terminal/);
  });

  it('merges an annotation into only its namespace and reports written for an existing row', async () => {
    const id = await insert({ uid: 1, annotations: { [pluginId]: { custom: 'keep', revision: 1 }, other: { untouched: true } } });
    expect(await setMessageAnnotation(accountId, id, pluginId, { revision: 2, queue: queued('done').queue })).toEqual({ kind: 'written' });
    expect((await annotationsById())[id]).toEqual({
      [pluginId]: { custom: 'keep', ...queued('done') }, other: { untouched: true },
    });
  });

  it('creates an absent plugin namespace without changing another plugin', async () => {
    const id = await insert({ uid: 1, annotations: { other: { untouched: true } } });
    expect(await setMessageAnnotation(accountId, id, pluginId, { custom: 'new' })).toEqual({ kind: 'written' });
    expect((await annotationsById())[id]).toEqual({ [pluginId]: { custom: 'new' }, other: { untouched: true } });
  });

  it('reports message_missing after deletion and for a row outside the requested account', async () => {
    const id = await insert({ uid: 1 });
    await database.query('DELETE FROM messages WHERE id = $1', [id]);
    expect(await setMessageAnnotation(accountId, id, pluginId, { custom: 'missing' })).toEqual({ kind: 'message_missing' });
    const foreign = await insert({ uid: 1, account: otherAccountId });
    expect(await setMessageAnnotation(accountId, foreign, pluginId, { custom: 'wrong account' })).toEqual({ kind: 'message_missing' });
    expect((await annotationsById())[foreign]).toEqual({});
  });
});
