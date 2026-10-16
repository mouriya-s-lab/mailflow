import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../plugins/api.js', async (importOriginal) => ({ ...(await importOriginal()), jevCategoryTabs: vi.fn() }));

import express from 'express';
import { query } from '../services/db.js';
import { jevCategoryTabs } from '../plugins/api.js';
import { listMessages } from '../services/messageService.js';
import mailRoutes from './mail.js';

const JEV_TABS = [{ id: 'personal', label: 'Personal' }, { id: 'review', label: 'Review' }];
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

// #jev-tabs: with Jev owning the tabs, a message's tab is Jev's recorded choice and its folder scope
// is INBOX plus the folder Jev moved it to. Uses only connection-local temporary tables in an
// explicitly supplied database, so nothing persists.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('Jev category tabs PostgreSQL', () => {
  let database, server, base;
  let nextId = 1;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

  // A Jev annotation: a decision for `choice`, and a category action (`action`) or none.
  const annotation = (choice, action = { kind: 'skipped', reason: 'not_in_inbox' }) => JSON.stringify({
    'jev-classify': {
      revision: 0,
      queue: { state: 'done', dueAt: null, origin: 'new_mail' },
      category: {
        decision: { kind: 'done', revision: 0, model: 'typesafe/jev', decidedAt: '2026-10-17T00:00:00.000Z', choice, confidence: 0.95 },
        action,
      },
    },
  });
  const moved = target => ({ kind: 'done', target, effect: 'moved' });
  const labeled = target => ({ kind: 'done', target, effect: 'labeled' });

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid, user_id text, enabled boolean,
        include_in_unified_inbox boolean, name text, email_address text, color text,
        folder_mappings jsonb);
      CREATE TEMP TABLE folders (account_id uuid, path text, name text, delimiter text,
        special_use text, total_count integer DEFAULT 0, unread_count integer DEFAULT 0);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text,
        uid bigint, message_id text, in_reply_to text, thread_references text,
        thread_id text, thread_key text, date timestamptz, is_deleted boolean DEFAULT false,
        subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        reply_to jsonb, snippet text, is_read boolean DEFAULT false, is_starred boolean DEFAULT false,
        has_attachments boolean DEFAULT false, category text, list_unsubscribe text,
        list_unsubscribe_post text, delivery_addresses jsonb, spam_verdict text,
        spam_user_override text, spam_score_ml real, flags jsonb, unsubscribed_at timestamptz,
        plugin_annotations jsonb NOT NULL DEFAULT '{}'::jsonb, sender_name text, sender_email text);
      CREATE TEMP TABLE contacts (id uuid, user_id text, primary_email text, photo_data text)`);
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
    nextId = 1;
    jevCategoryTabs.mockReset();
    jevCategoryTabs.mockResolvedValue(JEV_TABS);
    await database.query('TRUNCATE messages, folders, email_accounts, contacts');
    await database.query(
      "INSERT INTO email_accounts(id,user_id,enabled,include_in_unified_inbox,name,email_address,color,folder_mappings) VALUES ($1,'owner',true,true,'Work','me@example.com','#123456','{}')",
      [ACCOUNT],
    );
  });

  // subject → one row. `folder` is where the row sits; `annotationJson` carries Jev's decision.
  const insert = (subject, folder, annotationJson) => database.query(
    `INSERT INTO messages(id,account_id,folder,uid,message_id,thread_key,date,subject,from_email,plugin_annotations)
     VALUES ($1,$2,$3,$4,$5,$5,now(),$6,'sender@example.com',$7::jsonb)`,
    [id(), ACCOUNT, folder, nextId, `<${subject}@example.com>`, subject, annotationJson ?? '{}'],
  );

  // A Jev-decided fixture set. Expected under the personal tab: moved-out (Personal), still-in-INBOX,
  // and the INBOX copy of a label route. Not: a Trash copy, a label copy row, or another choice.
  const seed = async () => {
    await insert('moved-to-personal', 'Personal', annotation('personal', moved('Personal')));
    await insert('inbox-personal', 'INBOX', annotation('personal'));
    await insert('trashed-after-move', 'Trash', annotation('personal', moved('Personal')));
    await insert('labelled-inbox', 'INBOX', annotation('personal', labeled('Labels/Personal')));
    await insert('label-copy-row', 'Labels/Personal', annotation('personal', labeled('Labels/Personal')));
    await insert('inbox-review', 'INBOX', annotation('review'));
  };
  const subjects = messages => messages.map(m => m.subject).sort();

  it("lists a Jev-moved message under its tab, and only where Jev put it", async () => {
    await seed();
    const { messages } = await listMessages({
      userId: 'owner', category: 'personal', tabs: { kind: 'jev', categories: JEV_TABS },
    });
    expect(subjects(messages)).toEqual(['inbox-personal', 'labelled-inbox', 'moved-to-personal']);
  });

  it('keeps the built-in tab a plain INBOX listing, ignoring Jev annotations', async () => {
    await seed();
    await database.query("UPDATE messages SET category = 'newsletter' WHERE subject = 'inbox-review'");
    const { messages } = await listMessages({
      userId: 'owner', category: 'newsletter', tabs: { kind: 'builtin', ids: [] },
    });
    expect(subjects(messages)).toEqual(['inbox-review']);
  });

  it('serves the same Jev tab list through GET /api/mail/messages', async () => {
    await seed();
    const response = await fetch(`${base}/api/mail/messages?folder=INBOX&category=personal`);
    expect(response.status).toBe(200);
    expect(subjects((await response.json()).messages)).toEqual(['inbox-personal', 'labelled-inbox', 'moved-to-personal']);
  });

  it('counts each Jev tab over the same folder scope, with no duplicate label copy', async () => {
    await seed();
    const response = await fetch(`${base}/api/mail/category-counts`);
    expect((await response.json()).counts).toEqual({ personal: 3, review: 1 });
  });

  it('answers 409 to a manual categorize while Jev owns the tabs', async () => {
    await seed();
    const row = await database.query("SELECT id FROM messages WHERE subject = 'inbox-review'");
    const response = await fetch(`${base}/api/mail/messages/${row.rows[0].id}/category`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ category: 'automated' }),
    });
    expect(response.status).toBe(409);
    const stored = await database.query("SELECT category FROM messages WHERE subject = 'inbox-review'");
    expect(stored.rows[0].category).toBeNull();
  });
});
