// External service configuration an administrator sets in Settings (contract K11 in
// mouriya-s-lab/mailflow#5): the Jev endpoint and the link-reputation sources. Stored the way
// ai_config is: one system_settings row per service, keys encrypted with encrypt(), and admin
// responses carry a mask instead of a key. Read from the database on every use, so a change
// applies to the next call without a restart.
//
// A key in an admin request is the mask (keep the stored key), an empty string (clear it) or a
// new key. Keys are never logged and never returned in plaintext.

import { decrypt, encrypt } from '../../src/services/encryption.js';
import { query } from '../../src/services/db.js';
import { getConnectionPolicy } from '../../src/services/connectionPolicy.js';
import { validateHost } from '../../src/services/hostValidation.js';
import { MASKED_API_KEY } from '../../src/services/aiProvider.js';
import { JEV_DEFAULTS } from '../jev/index.js';

const JEV_SETTING = 'fork_jev_config';
const REPUTATION_SETTING = 'fork_reputation_config';
const REPUTATION_KEYS = ['spamhausDqsKey', 'urlhausAuthKey', 'safeBrowsingApiKey'];

const JEV_UNSET = Object.freeze({ ...JEV_DEFAULTS, apiKey: null });
const REPUTATION_UNSET = Object.freeze({
  rdapEnabled: true,
  ...Object.fromEntries(REPUTATION_KEYS.map(field => [field, null])),
});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const mask = stored => (stored ? MASKED_API_KEY : '');

class Invalid extends Error {}
const invalid = message => { throw new Invalid(message); };

function requiredString(input, field) {
  const value = typeof input[field] === 'string' ? input[field].trim() : '';
  return value || invalid(`${field} is required`);
}

// What a key field in an admin request asks for, applied to the stored ciphertext.
function nextKey(input, field, stored, encryptFn) {
  const value = input[field];
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  if (value === MASKED_API_KEY) return stored;
  const key = value.trim();
  return key ? encryptFn(key) : null;
}

// The plugin API builds the default instance on import, and suites that reach it through other
// modules mock these services partially, so each dependency is looked up per call, not bound here.
export function createServiceConfig({
  queryFn = (...args) => query(...args),
  encryptFn = value => encrypt(value),
  decryptFn = value => decrypt(value),
  validateHostFn = (...args) => validateHost(...args),
  getConnectionPolicyFn = () => getConnectionPolicy(),
} = {}) {
  async function read(setting, unset) {
    const result = await queryFn('SELECT value FROM system_settings WHERE key = $1', [setting]);
    return result.rows.length ? { ...unset, ...JSON.parse(result.rows[0].value) } : unset;
  }

  async function write(setting, value) {
    await queryFn(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [setting, JSON.stringify(value)],
    );
  }

  // A stored key that no longer decrypts (ENCRYPTION_KEY changed) must not read as "no key":
  // the admin page would still say the key is set while every caller silently went unconfigured.
  function reveal(stored, field) {
    if (!stored) return null;
    const key = decryptFn(stored);
    if (!key) throw new Error(`Stored ${field} cannot be decrypted; set it again in Settings`);
    return key;
  }

  async function save(parse) {
    try {
      return { kind: 'saved', config: await parse() };
    } catch (err) {
      if (err instanceof Invalid) return { kind: 'invalid', error: err.message };
      throw err;
    }
  }

  async function loadJevConfig() {
    const stored = await read(JEV_SETTING, JEV_UNSET);
    return { baseUrl: stored.baseUrl, model: stored.model, apiKey: reveal(stored.apiKey, 'Jev key') };
  }

  async function getAdminJevConfig() {
    const stored = await read(JEV_SETTING, JEV_UNSET);
    return { baseUrl: stored.baseUrl, model: stored.model, apiKey: mask(stored.apiKey) };
  }

  function saveJevConfig(input) {
    return save(async () => {
      if (!isRecord(input)) invalid('Request body must be an object');
      const baseUrl = requiredString(input, 'baseUrl');
      const model = requiredString(input, 'model');
      let url;
      try {
        url = new URL(baseUrl);
      } catch {
        invalid('baseUrl must be a URL');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') invalid('baseUrl must be an http or https URL');
      const policy = await getConnectionPolicyFn();
      const hostError = await validateHostFn(url.hostname, { allowPrivate: policy.allowPrivateHosts });
      if (hostError) invalid(`baseUrl: ${hostError}`);
      const stored = await read(JEV_SETTING, JEV_UNSET);
      const next = { baseUrl, model, apiKey: nextKey(input, 'apiKey', stored.apiKey, encryptFn) };
      await write(JEV_SETTING, next);
      return { baseUrl, model, apiKey: mask(next.apiKey) };
    });
  }

  async function getReputationConfig() {
    const stored = await read(REPUTATION_SETTING, REPUTATION_UNSET);
    return {
      rdapEnabled: stored.rdapEnabled,
      ...Object.fromEntries(REPUTATION_KEYS.map(field => [field, reveal(stored[field], field)])),
    };
  }

  async function getAdminReputationConfig() {
    const stored = await read(REPUTATION_SETTING, REPUTATION_UNSET);
    return {
      rdapEnabled: stored.rdapEnabled,
      ...Object.fromEntries(REPUTATION_KEYS.map(field => [field, mask(stored[field])])),
    };
  }

  function saveReputationConfig(input) {
    return save(async () => {
      if (!isRecord(input)) invalid('Request body must be an object');
      if (typeof input.rdapEnabled !== 'boolean') invalid('rdapEnabled must be true or false');
      const stored = await read(REPUTATION_SETTING, REPUTATION_UNSET);
      const next = {
        rdapEnabled: input.rdapEnabled,
        ...Object.fromEntries(REPUTATION_KEYS.map(field => [field, nextKey(input, field, stored[field], encryptFn)])),
      };
      await write(REPUTATION_SETTING, next);
      return {
        rdapEnabled: next.rdapEnabled,
        ...Object.fromEntries(REPUTATION_KEYS.map(field => [field, mask(next[field])])),
      };
    });
  }

  return {
    loadJevConfig,
    getAdminJevConfig,
    saveJevConfig,
    getReputationConfig,
    getAdminReputationConfig,
    saveReputationConfig,
  };
}

const serviceConfig = createServiceConfig();

export const loadJevConfig = serviceConfig.loadJevConfig;
export const getAdminJevConfig = serviceConfig.getAdminJevConfig;
export const saveJevConfig = serviceConfig.saveJevConfig;
export const getReputationConfig = serviceConfig.getReputationConfig;
export const getAdminReputationConfig = serviceConfig.getAdminReputationConfig;
export const saveReputationConfig = serviceConfig.saveReputationConfig;
