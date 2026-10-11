import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MASKED_API_KEY } from '../../src/services/aiProvider.js';
import { decide, status } from '../jev/index.js';
import { createServiceConfig } from './index.js';

const JEV_KEY = 'jev-admin-key-not-a-real-secret';
const NEW_JEV_KEY = 'jev-rotated-key-not-a-real-secret';
const DQS_KEY = 'spamhaus-dqs-key-not-real';
const URLHAUS_KEY = 'urlhaus-auth-key-not-real';
const SAFE_BROWSING_KEY = 'safe-browsing-key-not-real';
const ALL_KEYS = [JEV_KEY, NEW_JEV_KEY, DQS_KEY, URLHAUS_KEY, SAFE_BROWSING_KEY];
const DEFAULT_JEV = { baseUrl: 'https://api.commandcode.ai/provider/v1/systemone', model: 'typesafe/jev' };
const QUESTIONS = { spam: { kind: 'noul', instructions: 'Is this unsolicited bulk mail?' } };

let settings;
let writes;
let validatedHosts;
let logs;
let config;

function factory(overrides = {}) {
  return createServiceConfig({
    queryFn: async (sql, params = []) => {
      if (/^SELECT value FROM system_settings WHERE key = \$1$/.test(sql)) {
        return { rows: settings.has(params[0]) ? [{ value: settings.get(params[0]) }] : [] };
      }
      if (/^INSERT INTO system_settings/.test(sql)) {
        writes.push(params);
        settings.set(params[0], params[1]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    validateHostFn: async (host, options) => {
      validatedHosts.push({ host, options });
      return host === 'blocked.example.test' ? 'Host resolves to a private address' : null;
    },
    getConnectionPolicyFn: async () => ({ allowPrivateHosts: true }),
    ...overrides,
  });
}

function stored(setting) {
  return JSON.parse(settings.get(setting));
}

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', 'a1'.repeat(32));
  settings = new Map();
  writes = [];
  validatedHosts = [];
  logs = [];
  for (const level of ['log', 'warn', 'error']) {
    vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args); });
  }
  config = factory();
});

afterEach(() => {
  try {
    const persisted = JSON.stringify([...settings.values()]);
    const logged = JSON.stringify(logs);
    for (const key of ALL_KEYS) {
      expect(persisted).not.toContain(key);
      expect(logged).not.toContain(key);
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe('Jev configuration', () => {
  it('starts unconfigured with the default endpoint and model', async () => {
    expect(await config.loadJevConfig()).toEqual({ ...DEFAULT_JEV, apiKey: null });
    expect(await config.getAdminJevConfig()).toEqual({ ...DEFAULT_JEV, apiKey: '' });
    expect(status(await config.loadJevConfig())).toEqual({ kind: 'unconfigured' });
  });

  it('stores a new key encrypted, answers with the mask and hands the decrypted key to the client', async () => {
    const result = await config.saveJevConfig({ ...DEFAULT_JEV, apiKey: ` ${JEV_KEY} ` });
    expect(result).toEqual({ kind: 'saved', config: { ...DEFAULT_JEV, apiKey: MASKED_API_KEY } });
    expect(stored('fork_jev_config').apiKey).toMatch(/^enc:v1:/);
    expect(await config.getAdminJevConfig()).toEqual({ ...DEFAULT_JEV, apiKey: MASKED_API_KEY });
    expect(await config.loadJevConfig()).toEqual({ ...DEFAULT_JEV, apiKey: JEV_KEY });
    expect(status(await config.loadJevConfig())).toEqual({ kind: 'configured', ...DEFAULT_JEV });
    expect(validatedHosts).toEqual([{ host: 'api.commandcode.ai', options: { allowPrivate: true } }]);
  });

  it('keeps the stored key when the mask comes back and changes only the model', async () => {
    await config.saveJevConfig({ ...DEFAULT_JEV, apiKey: JEV_KEY });
    const ciphertext = stored('fork_jev_config').apiKey;
    expect(await config.saveJevConfig({ ...DEFAULT_JEV, model: 'typesafe/jev-next', apiKey: MASKED_API_KEY }))
      .toEqual({ kind: 'saved', config: { ...DEFAULT_JEV, model: 'typesafe/jev-next', apiKey: MASKED_API_KEY } });
    expect(stored('fork_jev_config').apiKey).toBe(ciphertext);
    expect(await config.loadJevConfig()).toEqual({ ...DEFAULT_JEV, model: 'typesafe/jev-next', apiKey: JEV_KEY });
  });

  it('replaces the key with a new one and clears it with an empty string', async () => {
    await config.saveJevConfig({ ...DEFAULT_JEV, apiKey: JEV_KEY });
    await config.saveJevConfig({ ...DEFAULT_JEV, apiKey: NEW_JEV_KEY });
    expect((await config.loadJevConfig()).apiKey).toBe(NEW_JEV_KEY);
    expect(await config.saveJevConfig({ ...DEFAULT_JEV, apiKey: '' }))
      .toEqual({ kind: 'saved', config: { ...DEFAULT_JEV, apiKey: '' } });
    expect(stored('fork_jev_config').apiKey).toBeNull();
    expect(await config.getAdminJevConfig()).toEqual({ ...DEFAULT_JEV, apiKey: '' });
    expect(status(await config.loadJevConfig())).toEqual({ kind: 'unconfigured' });
  });

  it('a cleared key makes a decision unconfigured without any request', async () => {
    await config.saveJevConfig({ ...DEFAULT_JEV, apiKey: JEV_KEY });
    await config.saveJevConfig({ ...DEFAULT_JEV, apiKey: '' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await decide(await config.loadJevConfig(), { state: 'state', questions: QUESTIONS }))
      .toEqual({ kind: 'error', error: { kind: 'unconfigured' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a saved configuration reaches the endpoint with its own URL, model and key', async () => {
    const requests = [];
    const server = createServer((incoming, response) => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => {
        requests.push({ url: incoming.url, authorization: incoming.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ model: 'test/jev', answers: { spam: { type: 'noul', noul: 0.25 } } }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}/decide`;
      await config.saveJevConfig({ baseUrl, model: 'test/jev', apiKey: JEV_KEY });
      const result = await decide(await config.loadJevConfig(), { state: 'state', questions: QUESTIONS });
      expect(result).toEqual({ kind: 'ok', answers: { spam: { kind: 'noul', probability: 0.25 } }, model: 'test/jev', inputTokens: null });
      expect(requests).toEqual([{
        url: '/decide',
        authorization: `Bearer ${JEV_KEY}`,
        body: { model: 'test/jev', state: 'state', questions: { spam: { type: 'noul', instructions: QUESTIONS.spam.instructions } } },
      }]);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it.each([
    ['a non-object body', null, 'Request body must be an object'],
    ['a missing base URL', { model: 'm', apiKey: '' }, 'baseUrl is required'],
    ['a blank model', { baseUrl: DEFAULT_JEV.baseUrl, model: '  ', apiKey: '' }, 'model is required'],
    ['a base URL that is not a URL', { baseUrl: 'commandcode', model: 'm', apiKey: '' }, 'baseUrl must be a URL'],
    ['a non-http base URL', { baseUrl: 'ftp://api.commandcode.ai/x', model: 'm', apiKey: '' }, 'baseUrl must be an http or https URL'],
    ['a host the connection policy refuses', { baseUrl: 'https://blocked.example.test/x', model: 'm', apiKey: '' },
      'baseUrl: Host resolves to a private address'],
    ['a missing key field', { baseUrl: DEFAULT_JEV.baseUrl, model: 'm' }, 'apiKey must be a string'],
  ])('rejects %s without writing anything', async (_name, input, error) => {
    expect(await config.saveJevConfig(input)).toEqual({ kind: 'invalid', error });
    expect(writes).toEqual([]);
  });

  it('fails loudly when the stored key no longer decrypts instead of reading as unconfigured', async () => {
    await config.saveJevConfig({ ...DEFAULT_JEV, apiKey: JEV_KEY });
    const rotated = factory({ decryptFn: () => null });
    await expect(rotated.loadJevConfig()).rejects.toThrow('Stored Jev key cannot be decrypted; set it again in Settings');
    expect(await rotated.getAdminJevConfig()).toEqual({ ...DEFAULT_JEV, apiKey: MASKED_API_KEY });
  });
});

describe('link reputation configuration', () => {
  const unset = { rdapEnabled: true, spamhausDqsKey: null, urlhausAuthKey: null, safeBrowsingApiKey: null };
  const keys = { spamhausDqsKey: DQS_KEY, urlhausAuthKey: URLHAUS_KEY, safeBrowsingApiKey: SAFE_BROWSING_KEY };
  const masked = { spamhausDqsKey: MASKED_API_KEY, urlhausAuthKey: MASKED_API_KEY, safeBrowsingApiKey: MASKED_API_KEY };

  it('starts with RDAP on and no optional source keys', async () => {
    expect(await config.getReputationConfig()).toEqual(unset);
    expect(await config.getAdminReputationConfig())
      .toEqual({ rdapEnabled: true, spamhausDqsKey: '', urlhausAuthKey: '', safeBrowsingApiKey: '' });
  });

  it('stores the RDAP switch and encrypted keys, and returns them decrypted', async () => {
    expect(await config.saveReputationConfig({ rdapEnabled: false, ...keys }))
      .toEqual({ kind: 'saved', config: { rdapEnabled: false, ...masked } });
    const row = stored('fork_reputation_config');
    expect(row.rdapEnabled).toBe(false);
    for (const field of Object.keys(keys)) expect(row[field]).toMatch(/^enc:v1:/);
    expect(await config.getReputationConfig()).toEqual({ rdapEnabled: false, ...keys });
    expect(await config.getAdminReputationConfig()).toEqual({ rdapEnabled: false, ...masked });
  });

  it('keeps masked keys, clears empty ones and turns RDAP back on', async () => {
    await config.saveReputationConfig({ rdapEnabled: false, ...keys });
    const before = stored('fork_reputation_config');
    await config.saveReputationConfig({ rdapEnabled: true, ...masked, urlhausAuthKey: '' });
    const after = stored('fork_reputation_config');
    expect(after.spamhausDqsKey).toBe(before.spamhausDqsKey);
    expect(after.safeBrowsingApiKey).toBe(before.safeBrowsingApiKey);
    expect(await config.getReputationConfig())
      .toEqual({ rdapEnabled: true, spamhausDqsKey: DQS_KEY, urlhausAuthKey: null, safeBrowsingApiKey: SAFE_BROWSING_KEY });
  });

  it.each([
    ['a non-object body', [], 'Request body must be an object'],
    ['a string RDAP switch', { rdapEnabled: 'off', spamhausDqsKey: '', urlhausAuthKey: '', safeBrowsingApiKey: '' },
      'rdapEnabled must be true or false'],
    ['a missing key field', { rdapEnabled: true, spamhausDqsKey: '', urlhausAuthKey: '' }, 'safeBrowsingApiKey must be a string'],
  ])('rejects %s without writing anything', async (_name, input, error) => {
    expect(await config.saveReputationConfig(input)).toEqual({ kind: 'invalid', error });
    expect(writes).toEqual([]);
  });
});
