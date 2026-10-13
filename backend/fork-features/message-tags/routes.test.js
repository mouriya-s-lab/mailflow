import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../src/services/db.js', () => ({ query: mocks.query }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));

import express from 'express';
import 'express-async-errors';
import routes from './routes.js';
import { pluginRegistry } from '../../src/plugins/registry.js';

const USER = 'user-1';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNED = id(1);
const FOREIGN = id(2);

let server;
let base;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: USER, username: USER };
    next();
  });
  app.use('/api/message-tags', routes);
  // eslint-disable-next-line no-unused-vars
  app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  return app;
}

async function request(body) {
  const response = await fetch(`${base}/api/message-tags/summary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

beforeAll(async () => {
  server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql, params) => {
    if (sql.includes('JOIN email_accounts')) {
      const [userId, ids] = params;
      return { rows: userId === USER && ids.includes(OWNED) ? [{ id: OWNED, account_id: ACCOUNT }] : [] };
    }
    if (sql.includes('SELECT id FROM messages WHERE account_id')) {
      const [accountId, ids] = params;
      return { rows: accountId === ACCOUNT && ids.includes(OWNED) ? [{ id: OWNED }] : [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
});

describe('POST /api/message-tags/summary', () => {
  it('answers the caller\'s own messages through the registered tag plugin', async () => {
    if (!pluginRegistry.has('test-tag-rdap')) {
      pluginRegistry.register({
        id: 'test-tag-rdap',
        name: 'Test RDAP tag source',
        version: '1.0.0',
        tier: 1,
        tagSource: {
          source: 'rdap',
          ensure: async () => { throw new Error('the summary must not ask a plugin to look anything up'); },
          read: async (accountId, ids) => new Map(ids.map(i => [i, {
            kind: 'complete',
            checkedAt: '2026-10-12T00:00:00.000Z',
            subjects: { 'new.example': { kind: 'known', registeredAt: '2026-10-11T00:00:00.000Z' } },
          }])),
        },
      });
    }
    const { status, json } = await request({ ids: [OWNED, FOREIGN] });
    expect(status).toBe(200);
    expect(Object.keys(json.tags)).toEqual([OWNED]);
    // The chip's age is measured against the wall clock, so only its shape is asserted here.
    expect(json.tags[OWNED].notable).toHaveLength(1);
    expect(json.tags[OWNED].notable[0]).toMatchObject({ kind: 'new_domain', domain: 'new.example' });
    expect(typeof json.tags[OWNED].notable[0].ageDays).toBe('number');
    expect(json.tags[OWNED].sources.rdap).toEqual({ kind: 'complete', checkedAt: '2026-10-12T00:00:00.000Z', subjects: 1, listed: 0, unknown: 0 });
    expect(json.tags[OWNED].sources.urlhaus).toEqual({ kind: 'inactive' });
  });

  it('rejects a body that is not a list of ids', async () => {
    const { status, json } = await request({ ids: 'all' });
    expect(status).toBe(400);
    expect(json.error).toBe('ids must be an array');
  });
});
