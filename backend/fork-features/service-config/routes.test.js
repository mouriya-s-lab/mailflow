import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../src/services/db.js', () => ({ query: mocks.query }));
vi.mock('../../src/services/hostValidation.js', () => ({ validateHost: async () => null }));

import express from 'express';
import 'express-async-errors';
import routes from './routes.js';

const ADMIN = 'admin-user';
const MEMBER = 'ordinary-user';
const JEV_KEY = 'jev-route-key-not-a-real-secret';
const DQS_KEY = 'spamhaus-route-key-not-real';
const MASK = '••••••••';
const JEV = { baseUrl: 'https://api.commandcode.ai/provider/v1/systemone', model: 'typesafe/jev' };

let server;
let base;
let settings;
let logs;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    if (userId) req.session = { userId, username: userId };
    next();
  });
  app.use('/api/admin/fork', routes);
  // eslint-disable-next-line no-unused-vars
  app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  return app;
}

async function request(path, { method = 'GET', user = ADMIN, body } = {}) {
  const headers = {};
  if (user) headers['x-test-user'] = user;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}/api/admin/fork${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  await new Promise(resolve => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', 'b2'.repeat(32));
  settings = new Map();
  logs = [];
  for (const level of ['log', 'warn', 'error']) {
    vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args); });
  }
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql, params = []) => {
    if (/SELECT is_admin FROM users/.test(sql)) return { rows: [{ is_admin: params[0] === ADMIN }] };
    if (/UPDATE users SET last_seen_at/.test(sql)) return { rows: [] };
    if (/WHERE key IN \('allow_private_hosts'/.test(sql)) return { rows: [] };
    if (/SELECT value FROM system_settings WHERE key = \$1/.test(sql)) {
      return { rows: settings.has(params[0]) ? [{ value: settings.get(params[0]) }] : [] };
    }
    if (/INSERT INTO system_settings/.test(sql)) {
      settings.set(params[0], params[1]);
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
});

afterEach(() => {
  try {
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(JEV_KEY);
    expect(logged).not.toContain(DQS_KEY);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe('admin service configuration routes', () => {
  it.each([
    ['GET', '/jev'], ['PUT', '/jev'], ['GET', '/reputation'], ['PUT', '/reputation'],
  ])('%s %s is 401 without a session and 403 for a non-admin, writing nothing', async (method, path) => {
    const body = method === 'PUT' ? { ...JEV, apiKey: JEV_KEY, rdapEnabled: false } : undefined;
    expect((await request(path, { method, user: null, body })).status).toBe(401);
    const member = await request(path, { method, user: MEMBER, body });
    expect(member.status).toBe(403);
    expect(JSON.parse(member.text)).toEqual({ error: 'Admin access required' });
    expect(settings.size).toBe(0);
  });

  it('saves the Jev key encrypted and only ever answers with the mask', async () => {
    const saved = await request('/jev', { method: 'PUT', body: { ...JEV, apiKey: JEV_KEY } });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.text)).toEqual({ ok: true, config: { ...JEV, apiKey: MASK } });
    expect(JSON.parse(settings.get('fork_jev_config')).apiKey).toMatch(/^enc:v1:/);
    expect(settings.get('fork_jev_config')).not.toContain(JEV_KEY);
    const loaded = await request('/jev');
    expect(JSON.parse(loaded.text)).toEqual({ config: { ...JEV, apiKey: MASK } });
    for (const response of [saved, loaded]) expect(response.text).not.toContain(JEV_KEY);
    expect(logs).toContainEqual([`[admin] ${ADMIN} updated Jev config`]);
  });

  it('answers 400 with the reason for an invalid Jev configuration', async () => {
    const response = await request('/jev', { method: 'PUT', body: { baseUrl: 'ftp://x.test', model: 'm', apiKey: JEV_KEY } });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toEqual({ error: 'baseUrl must be an http or https URL' });
    expect(settings.size).toBe(0);
  });

  it('saves and reads the link reputation settings masked', async () => {
    const body = { rdapEnabled: false, spamhausDqsKey: DQS_KEY, urlhausAuthKey: '', safeBrowsingApiKey: '' };
    const saved = await request('/reputation', { method: 'PUT', body });
    expect(saved.status).toBe(200);
    const config = { rdapEnabled: false, spamhausDqsKey: MASK, urlhausAuthKey: '', safeBrowsingApiKey: '' };
    expect(JSON.parse(saved.text)).toEqual({ ok: true, config });
    const loaded = await request('/reputation');
    expect(JSON.parse(loaded.text)).toEqual({ config });
    for (const response of [saved, loaded]) expect(response.text).not.toContain(DQS_KEY);
    const invalid = await request('/reputation', { method: 'PUT', body: { ...body, rdapEnabled: 'yes' } });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.text)).toEqual({ error: 'rdapEnabled must be true or false' });
  });
});
