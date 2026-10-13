import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/db.js', () => ({ query: vi.fn() }));

import { logger } from '../../src/services/logger.js';
import { createMessageTags, tagChips, TAG_SOURCES, NEW_DOMAIN_MAX_AGE_MS } from './index.js';

// A messages table of two accounts of two users, and a registry of tag plugins the test builds
// per case. Nothing here reaches a reputation source: the plugins stand in for them.
const USER = 'user-1';
const OTHER_USER = 'user-2';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000002';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-13T00:00:00Z');

const complete = (subjects, checkedAt = '2026-10-12T00:00:00.000Z') => ({ kind: 'complete', checkedAt, subjects });

let messages; // id -> { id, account_id, user_id }
let registry;
let tags;

function plugin(source, overrides = {}) {
  const tag = {
    source,
    ensure: vi.fn(async (accountId, ids) => new Map(ids.map(i => [i, complete({})]))),
    read: vi.fn(async (accountId, ids) => new Map(ids.map(i => [i, { kind: 'unchecked' }]))),
  };
  for (const [name, value] of Object.entries(overrides)) tag[name] = vi.fn(value);
  registry.list().push({ id: `tag-${source}`, name: source, version: '1.0.0', tier: 1, tagSource: tag });
  return tag;
}

beforeEach(() => {
  messages = new Map([
    [id(1), { id: id(1), account_id: ACCOUNT, user_id: USER }],
    [id(2), { id: id(2), account_id: ACCOUNT, user_id: USER }],
    [id(3), { id: id(3), account_id: OTHER_ACCOUNT, user_id: OTHER_USER }],
  ]);
  const manifests = [];
  registry = { list: () => manifests };
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const queryFn = async (sql, params) => {
    if (sql.includes('JOIN email_accounts')) {
      const [userId, ids] = params;
      return { rows: ids.map(i => messages.get(i)).filter(r => r && r.user_id === userId).map(r => ({ id: r.id, account_id: r.account_id })) };
    }
    if (sql.includes('SELECT id FROM messages WHERE account_id')) {
      const [accountId, ids] = params;
      return { rows: ids.map(i => messages.get(i)).filter(r => r && r.account_id === accountId).map(r => ({ id: r.id })) };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  };
  tags = createMessageTags({ registry, queryFn, now: () => NOW });
});

describe('ensureMessageTags', () => {
  it('answers every source for every id of the account, and nothing for another account\'s id', async () => {
    plugin('rdap', { ensure: async (accountId, ids) => new Map(ids.map(i => [i, complete({ 'new.com': { kind: 'known', registeredAt: '2026-10-05T00:00:00.000Z' } })])) });
    const states = await tags.ensureMessageTags(ACCOUNT, [id(1), id(3)], { deadlineMs: 100 });
    expect([...states.keys()]).toEqual([id(1)]);
    expect(Object.keys(states.get(id(1)))).toEqual([...TAG_SOURCES]);
    expect(states.get(id(1)).rdap.kind).toBe('complete');
    // No plugin registered for the other three sources: they read as not activated, not as clean.
    expect(states.get(id(1)).spamhaus_dbl).toEqual({ kind: 'inactive' });
    expect(states.get(id(1)).safe_browsing).toEqual({ kind: 'inactive' });
  });

  it('gives the plugin the caller\'s remaining time', async () => {
    const rdap = plugin('rdap');
    await tags.ensureMessageTags(ACCOUNT, [id(1)], { deadlineMs: 5000 });
    expect(rdap.ensure).toHaveBeenCalledWith(ACCOUNT, [id(1)], { deadlineMs: 5000 });
  });

  it('is one source\'s unavailable when that plugin throws, and answers the others', async () => {
    plugin('rdap', { ensure: async () => { throw new Error('rdap is down'); } });
    plugin('urlhaus', { ensure: async (accountId, ids) => new Map(ids.map(i => [i, complete({ 'a.com': { kind: 'listed', detail: 'x' } })])) });
    const states = await tags.ensureMessageTags(ACCOUNT, [id(1)], { deadlineMs: 100 });
    expect(states.get(id(1)).rdap).toEqual({ kind: 'unavailable', reason: 'plugin_failed' });
    expect(states.get(id(1)).urlhaus.kind).toBe('complete');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tag-rdap ensure failed: rdap is down'));
  });

  it('is unavailable { deadline } when a plugin does not answer in time, and warns', async () => {
    plugin('rdap', { ensure: () => new Promise(() => {}) });
    const states = await tags.ensureMessageTags(ACCOUNT, [id(1)], { deadlineMs: 30 });
    expect(states.get(id(1)).rdap).toEqual({ kind: 'unavailable', reason: 'deadline' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tag-rdap ensure did not answer in time'));
  });

  it('is unavailable { plugin_failed } for an id a plugin left out of its answer, and warns', async () => {
    plugin('rdap', { ensure: async () => new Map() });
    const states = await tags.ensureMessageTags(ACCOUNT, [id(1), id(2)], { deadlineMs: 100 });
    expect(states.get(id(1)).rdap).toEqual({ kind: 'unavailable', reason: 'plugin_failed' });
    expect(states.get(id(2)).rdap).toEqual({ kind: 'unavailable', reason: 'plugin_failed' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('left some of 2 message(s) out of its answer'));
  });

  it('is unavailable { plugin_failed } when a plugin answers with something that is not a Map', async () => {
    plugin('rdap', { ensure: async () => ({ [id(1)]: complete({}) }) });
    const states = await tags.ensureMessageTags(ACCOUNT, [id(1)], { deadlineMs: 100 });
    expect(states.get(id(1)).rdap).toEqual({ kind: 'unavailable', reason: 'plugin_failed' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('instead of a Map'));
  });

  it('refuses a deadline that is not a number, and an unknown source', async () => {
    await expect(tags.ensureMessageTags(ACCOUNT, [id(1)], {})).rejects.toThrow(/deadlineMs/);
    await expect(tags.ensureMessageTags(ACCOUNT, [id(1)], { deadlineMs: -1 })).rejects.toThrow(/deadlineMs/);
    plugin('who_knows');
    await expect(tags.ensureMessageTags(ACCOUNT, [id(1)], { deadlineMs: 100 })).rejects.toThrow(/unknown tag source/);
  });
});

describe('getMessageTags', () => {
  it('answers from what is stored, with no deadline and no external query', async () => {
    const rdap = plugin('rdap', { read: async (accountId, ids) => new Map(ids.map(i => [i, { kind: 'unchecked' }])) });
    const states = await tags.getMessageTags(ACCOUNT, [id(1)]);
    expect(states.get(id(1)).rdap).toEqual({ kind: 'unchecked' });
    expect(rdap.read).toHaveBeenCalledWith(ACCOUNT, [id(1)]);
    expect(rdap.ensure).not.toHaveBeenCalled();
  });

  it('is unavailable when a read handler throws', async () => {
    plugin('rdap', { read: async () => { throw new Error('no storage'); } });
    const states = await tags.getMessageTags(ACCOUNT, [id(1)]);
    expect(states.get(id(1)).rdap).toEqual({ kind: 'unavailable', reason: 'plugin_failed' });
  });
});

describe('tagChips', () => {
  const record = overrides => ({ ...Object.fromEntries(TAG_SOURCES.map(s => [s, { kind: 'inactive' }])), ...overrides });

  it('chips a listed domain, a new domain with its age, and a source that could not tell', () => {
    const chips = tagChips(record({
      rdap: complete({ 'new.example': { kind: 'known', registeredAt: '2026-10-05T00:00:00.000Z' }, 'old.example': { kind: 'known', registeredAt: '1999-01-01T00:00:00.000Z' } }),
      spamhaus_dbl: complete({ 'phish.example': { kind: 'listed', detail: 'phishing' }, 'ok.example': { kind: 'not_listed' } }),
      urlhaus: complete({ 'x.example': { kind: 'unknown', reason: 'timeout' } }),
    }), NOW);
    expect(chips).toEqual([
      { kind: 'new_domain', domain: 'new.example', ageDays: 8 },
      { kind: 'listed', source: 'spamhaus_dbl' },
      { kind: 'unknown', source: 'urlhaus' },
    ]);
  });

  it('chips nothing for a domain that is not new, a source that answered not listed, and one that is off', () => {
    const chips = tagChips(record({
      rdap: complete({ 'old.example': { kind: 'known', registeredAt: '1999-01-01T00:00:00.000Z' }, 'gone.example': { kind: 'not_found' } }),
      urlhaus: complete({ 'old.example': { kind: 'not_listed' } }),
      safe_browsing: { kind: 'unconfigured' },
    }), NOW);
    expect(chips).toEqual([]);
  });

  it('chips an unknown chip for a registration date it cannot use, and never for not_found', () => {
    expect(tagChips(record({ rdap: complete({ 'a.example': { kind: 'known', registeredAt: '2099-01-01T00:00:00.000Z' } }) }), NOW))
      .toEqual([{ kind: 'unknown', source: 'rdap' }]);
    expect(tagChips(record({ rdap: complete({ 'a.example': { kind: 'unknown', reason: 'error' } }) }), NOW))
      .toEqual([{ kind: 'unknown', source: 'rdap' }]);
    expect(tagChips(record({ rdap: complete({ 'a.example': { kind: 'not_found' } }) }), NOW)).toEqual([]);
  });

  it('does not call a domain new at exactly the age limit', () => {
    const registeredAt = new Date(NOW - NEW_DOMAIN_MAX_AGE_MS).toISOString();
    expect(tagChips(record({ rdap: complete({ 'edge.example': { kind: 'known', registeredAt } }) }), NOW)).toEqual([]);
  });
});

describe('summarizeForUser', () => {
  it('answers the caller\'s own messages only, with chips and a per-source summary that holds no URL', async () => {
    plugin('safe_browsing', {
      read: async (accountId, ids) => new Map(ids.map(i => [i, complete({ abcdef0123: { host: 'phish.example', verdict: { kind: 'listed', detail: 'SOCIAL_ENGINEERING' } } })])),
    });
    const result = await tags.summarizeForUser(USER, [id(1), id(3)]);
    expect(result.kind).toBe('ok');
    expect(Object.keys(result.tags)).toEqual([id(1)]);
    expect(result.tags[id(1)].notable).toEqual([{ kind: 'listed', source: 'safe_browsing' }]);
    expect(result.tags[id(1)].sources.safe_browsing).toEqual({ kind: 'complete', checkedAt: '2026-10-12T00:00:00.000Z', subjects: 1, listed: 1, unknown: 0 });
    expect(result.tags[id(1)].sources.rdap).toEqual({ kind: 'inactive' });
    expect(JSON.stringify(result)).not.toContain('phish.example');
    expect(JSON.stringify(result)).not.toContain('abcdef0123');
  });

  it('rejects a body that is not a list of ids, and one that is too long', async () => {
    expect(await tags.summarizeForUser(USER, 'nope')).toEqual({ kind: 'invalid', error: 'ids must be an array' });
    expect(await tags.summarizeForUser(USER, [1])).toEqual({ kind: 'invalid', error: 'ids must be an array of message ids' });
    const tooMany = Array.from({ length: 201 }, (_, n) => id(n));
    expect(await tags.summarizeForUser(USER, tooMany)).toEqual({ kind: 'invalid', error: 'at most 200 ids per request' });
  });

  it('answers an empty list without querying anything', async () => {
    expect(await tags.summarizeForUser(USER, [])).toEqual({ kind: 'ok', tags: {} });
  });
});
