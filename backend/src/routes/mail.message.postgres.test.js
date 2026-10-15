import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'owner' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
import express from 'express';
import { query } from '../services/db.js';
import mailRoutes from './mail.js';

// Execute the real route SQL against connection-local tables, never query-result fixtures.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('GET /api/mail/messages/:id PostgreSQL', () => {
  let database, server, base;
  const account = '11111111-1111-4111-8111-111111111111';
  const foreignAccount = '22222222-2222-4222-8222-222222222222';
  const target = '00000000-0000-4000-8000-000000000001';
  const newerReply = '00000000-0000-4000-8000-000000000002';
  const labelSibling = '00000000-0000-4000-8000-000000000003';
  const deleted = '00000000-0000-4000-8000-000000000004';
  const foreign = '00000000-0000-4000-8000-000000000005';
  const missing = '00000000-0000-4000-8000-000000000006';
  const threadKey = '<conversation-root@example.com>';

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id text,
        name text, email_address text, color text);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, uid bigint,
        folder text, message_id text, thread_id text, thread_key text, subject text,
        from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        reply_to jsonb, in_reply_to text, thread_references text, date timestamptz,
        snippet text, is_read boolean DEFAULT false, is_starred boolean DEFAULT false,
        has_attachments boolean DEFAULT false, category text, list_unsubscribe text,
        list_unsubscribe_post text, unsubscribed_at timestamptz, delivery_addresses jsonb,
        spam_verdict text, spam_user_override text, spam_score_ml real,
        is_deleted boolean DEFAULT false)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
    const app = express();
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.end();
  });

  beforeEach(async () => {
    await database.query('TRUNCATE messages, email_accounts');
    await database.query(
      `INSERT INTO email_accounts (id, user_id, name, email_address, color)
       VALUES ($1, 'owner', 'Work', 'me@example.com', '#123456'),
              ($2, 'someone-else', 'Foreign', 'other@example.com', '#654321')`,
      [account, foreignAccount],
    );
    await database.query(
      `INSERT INTO messages
         (id, account_id, uid, folder, message_id, thread_id, thread_key, subject, date, is_deleted)
       VALUES
         ($1, $6, 101, 'INBOX', '<requested@example.com>', '<legacy-target@example.com>', $8,
          'Requested physical message', '2026-10-01T10:00Z', false),
         ($2, $6, 202, 'Sent', '<reply@example.com>', '<legacy-reply@example.com>', $8,
          'Newer conversation reply', '2026-10-01T11:00Z', false),
         ($3, $6, 303, 'Archive', '<requested@example.com>', '<legacy-label@example.com>', $8,
          'Other label copy', '2026-10-01T12:00Z', false),
         ($4, $6, 404, 'Trash', '<requested@example.com>', '<legacy-deleted@example.com>', $8,
          'Deleted physical message', '2026-10-01T13:00Z', true),
         ($5, $7, 505, 'INBOX', '<requested@example.com>', '<legacy-foreign@example.com>', $8,
          'Foreign physical message', '2026-10-01T14:00Z', false)`,
      [target, newerReply, labelSibling, deleted, foreign, account, foreignAccount, threadKey],
    );
  });

  it('returns the requested physical row with normalized reply identity and singleton presentation', async () => {
    const response = await fetch(`${base}/api/mail/messages/${target}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: target,
      account_id: account,
      uid: '101',
      folder: 'INBOX',
      message_id: '<requested@example.com>',
      subject: 'Requested physical message',
      thread_id: threadKey,
      message_count: 1,
    });
  });

  it.each([
    ['missing', missing],
    ['deleted despite a live label sibling', deleted],
    ['foreign-owned despite an owned label sibling', foreign],
  ])('returns 404 for a %s UUID without resolving another row', async (_case, id) => {
    const response = await fetch(`${base}/api/mail/messages/${id}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Message not found' });
  });
});
