import { createServer } from 'node:http';
import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostOfUrl, registrableDomain } from '../domains/index.js';
import { expressionHash, urlExpressions } from './safeBrowsing.js';

const DQS_KEY = 'dqskeynotarealsecret0000001';
const URLHAUS_KEY = 'urlhaus-key-not-a-real-secret';
const SAFE_BROWSING_KEY = 'safe-browsing-key-not-a-real-secret';
const KEYS = [DQS_KEY, URLHAUS_KEY, SAFE_BROWSING_KEY];
const START = Date.parse('2026-10-12T08:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const RDAP_ONLY = { rdapEnabled: true, spamhausDqsKey: null, urlhausAuthKey: null, safeBrowsingApiKey: null };

let createReputation;
let clock;
let warn;
let closers;
let lookedUp;

// fork_reputation_cache in memory, answering the module's two statements the way PostgreSQL does.
function fakeDatabase() {
  const rows = new Map();
  const statements = [];
  const queryFn = async (sql, params) => {
    statements.push({ sql, params });
    if (sql.startsWith('SELECT subject, result, fetched_at FROM fork_reputation_cache')) {
      const [source, subjects, at] = params;
      return {
        rows: subjects.map(s => rows.get(`${source}|${s}`)).filter(r => r && r.expires_at > at)
          .map(r => ({ subject: r.subject, result: structuredClone(r.result), fetched_at: r.fetched_at })),
      };
    }
    if (sql.startsWith('INSERT INTO fork_reputation_cache')) {
      const [source, subjects, results, fetched, expires] = params;
      subjects.forEach((subject, i) => rows.set(`${source}|${subject}`, {
        subject, result: JSON.parse(results[i]), fetched_at: fetched[i], expires_at: expires[i],
      }));
      return { rows: [], rowCount: subjects.length };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return {
    queryFn,
    row: (source, subject) => rows.get(`${source}|${subject}`),
    reads: source => statements.filter(s => s.sql.startsWith('SELECT') && s.params[0] === source).length,
    writes: () => statements.filter(s => s.sql.startsWith('INSERT')).length,
    statementCount: () => statements.length,
    // The sources of the statements after the first `from`, reads and writes alike.
    sourcesSince: from => [...new Set(statements.slice(from).map(s => s.params[0]))],
    writtenSince: from => [...new Set(statements.slice(from).filter(s => s.sql.startsWith('INSERT')).map(s => s.params[0]))],
  };
}

async function startHttp(handler) {
  const requests = [];
  const server = createServer((incoming, response) => {
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      const record = { method: incoming.method, url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(record);
      handler(record, response);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  closers.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { server, port, requests, base: `http://127.0.0.1:${port}` };
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

const rdapDomain = (name, registered) => ({
  objectClassName: 'domain',
  ldhName: name.toUpperCase(),
  events: [
    { eventAction: 'expiration', eventDate: '2030-04-29T04:00:00Z' },
    { eventAction: 'registration', eventDate: registered },
  ],
});

// IANA bootstrap and one registry RDAP server on the same local HTTP server.
async function startRdap(answer = (_name, response) => sendJson(response, rdapDomain(_name, '1997-04-28T04:00:00Z'))) {
  const http = await startHttp((record, response) => {
    if (record.url === '/bootstrap/dns.json') {
      sendJson(response, { version: '1.0', services: [[['net'], ['https://rdap.example.net/']], [['com', 'uk'], [`${http.base}/rdap/`]]] });
      return;
    }
    const match = /^\/rdap\/domain\/(.+)$/.exec(record.url);
    if (!match) { sendJson(response, {}, 400); return; }
    lookedUp.push(match[1]);
    answer(match[1], response);
  });
  return http;
}

// A recursive resolver: answer(name) is { rcode, addresses: [{ address, ttl }], soa: { ttl, minimum } }
// or 'drop' for no reply at all.
async function startDns(answer) {
  const socket = dgram.createSocket('udp4');
  const queries = [];
  socket.on('message', (message, from) => {
    let offset = 12;
    const labels = [];
    while (message[offset]) {
      labels.push(message.subarray(offset + 1, offset + 1 + message[offset]).toString('ascii'));
      offset += message[offset] + 1;
    }
    const question = message.subarray(12, offset + 5);
    const name = labels.join('.');
    queries.push({ name, type: question.readUInt16BE(question.length - 4) });
    const reply = answer(name);
    if (reply === 'drop') return;
    const { rcode = 0, addresses = [], soa = null } = reply;
    const header = Buffer.alloc(12);
    header.writeUInt16BE(message.readUInt16BE(0), 0);
    header.writeUInt16BE(0x8180 | rcode, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(addresses.length, 6);
    header.writeUInt16BE(soa ? 1 : 0, 8);
    const records = addresses.map(({ address, ttl }) => {
      const record = Buffer.alloc(16);
      record.writeUInt16BE(0xc00c, 0);
      record.writeUInt16BE(1, 2);
      record.writeUInt16BE(1, 4);
      record.writeUInt32BE(ttl, 6);
      record.writeUInt16BE(4, 10);
      address.split('.').forEach((byte, i) => { record[12 + i] = Number(byte); });
      return record;
    });
    if (soa) {
      const record = Buffer.alloc(12 + 22);
      record.writeUInt16BE(0xc00c, 0);
      record.writeUInt16BE(6, 2);
      record.writeUInt16BE(1, 4);
      record.writeUInt32BE(soa.ttl, 6);
      record.writeUInt16BE(22, 10);
      // MNAME and RNAME as the root, then serial, refresh, retry, expire, minimum.
      [1, 3600, 600, 86400, soa.minimum].forEach((value, i) => record.writeUInt32BE(value, 14 + i * 4));
      records.push(record);
    }
    socket.send(Buffer.concat([header, question, ...records]), from.port, from.address);
  });
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  closers.push(() => new Promise(resolve => socket.close(resolve)));
  return { server: `127.0.0.1:${socket.address().port}`, queries };
}

function reputation({ config = RDAP_ONLY, database = fakeDatabase(), fetchFn = fetch, endpoints = {} } = {}) {
  const instance = createReputation({
    queryFn: database.queryFn,
    getConfigFn: async () => (typeof config === 'function' ? config() : config),
    fetchFn,
    endpoints,
    now: () => clock,
  });
  return { ...instance, database };
}

const reputationLines = source => warn.mock.calls.map(args => args.join(' ')).filter(line => line.includes(`[reputation] ${source} `));

beforeEach(async () => {
  clock = START;
  closers = [];
  lookedUp = [];
  vi.stubEnv('LOG_LEVEL', 'warn');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.resetModules();
  ({ createReputation } = await import('./index.js'));
});

afterEach(async () => {
  try {
    const logs = JSON.stringify(warn.mock.calls);
    for (const key of KEYS) expect(logs).not.toContain(key);
    expect(logs).not.toMatch(/example\.(com|co\.uk)/);
  } finally {
    await Promise.all(closers.map(close => close()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe('RDAP registration', () => {
  it('maps registration, absence and an unsupported TLD, and a second lookup sends nothing', async () => {
    const rdap = await startRdap((name, response) => (name === 'gone.com'
      ? sendJson(response, { errorCode: 404 }, 404)
      : sendJson(response, rdapDomain(name, name === 'fresh.com' ? '2026-10-03T11:22:33Z' : '1997-04-28T04:00:00Z'))));
    const rep = reputation({ endpoints: { rdapBootstrap: `${rdap.base}/bootstrap/dns.json` } });
    const domains = ['old.com', 'fresh.com', 'gone.com', 'example.org'];

    const first = await rep.lookupRdap(domains, { deadlineMs: 5000 });
    expect(Object.fromEntries(first)).toEqual({
      'old.com': { kind: 'known', registeredAt: '1997-04-28T04:00:00.000Z' },
      'fresh.com': { kind: 'known', registeredAt: '2026-10-03T11:22:33.000Z' },
      'gone.com': { kind: 'not_found' },
      'example.org': { kind: 'unknown', reason: 'unsupported_tld' },
    });
    expect(rdap.requests.map(r => r.url).sort()).toEqual(['/bootstrap/dns.json', '/rdap/domain/fresh.com', '/rdap/domain/gone.com', '/rdap/domain/old.com']);
    expect(rep.database.row('rdap', 'old.com')).toMatchObject({ fetched_at: new Date(START), expires_at: new Date(START + 30 * DAY) });
    expect(rep.database.row('rdap', 'gone.com')).toMatchObject({ fetched_at: new Date(START), expires_at: new Date(START + DAY) });
    expect(rep.database.row('rdap', 'example.org')).toBeUndefined();
    expect(reputationLines('rdap')).toEqual([]);

    clock += 10 * MINUTE;
    const requestsBefore = rdap.requests.length;
    const second = await rep.lookupRdap(['old.com', 'fresh.com', 'gone.com'], { deadlineMs: 5000 });
    expect(rdap.requests.length).toBe(requestsBefore);
    expect(second.get('old.com')).toEqual(first.get('old.com'));
    expect(second.get('gone.com')).toEqual({ kind: 'not_found' });
    expect(rep.database.row('rdap', 'old.com').fetched_at).toEqual(new Date(START));

    // not_found is asked again once its day is over; known still comes from the cache.
    clock = START + DAY + MINUTE;
    await rep.lookupRdap(['old.com', 'gone.com'], { deadlineMs: 5000 });
    expect(lookedUp.filter(d => d === 'gone.com')).toHaveLength(2);
    expect(lookedUp.filter(d => d === 'old.com')).toHaveLength(1);
  });

  it('reads a 200 without a registration date as unknown, not as a known age', async () => {
    const rdap = await startRdap((name, response) => sendJson(response, { objectClassName: 'domain', events: [{ eventAction: 'last changed', eventDate: '2024-01-01T00:00:00Z' }] }));
    const rep = reputation({ endpoints: { rdapBootstrap: `${rdap.base}/bootstrap/dns.json` } });
    const result = await rep.lookupRdap(['undated.com'], { deadlineMs: 5000 });
    expect(result.get('undated.com')).toEqual({ kind: 'unknown', reason: 'error' });
    expect(rep.database.writes()).toBe(0);
    expect(reputationLines('rdap')).toEqual(['[warn] [reputation] rdap lookup failed: no registration date in the response']);
  });

  it('maps 429 to rate_limited and other statuses to error, and stores neither', async () => {
    const rdap = await startRdap((name, response) => sendJson(response, {}, name === 'busy.com' ? 429 : 503));
    const rep = reputation({ endpoints: { rdapBootstrap: `${rdap.base}/bootstrap/dns.json` } });
    const result = await rep.lookupRdap(['busy.com', 'down.com'], { deadlineMs: 5000 });
    expect(result.get('busy.com')).toEqual({ kind: 'unknown', reason: 'rate_limited' });
    expect(result.get('down.com')).toEqual({ kind: 'unknown', reason: 'error' });
    expect(rep.database.writes()).toBe(0);
    expect(reputationLines('rdap')).toHaveLength(1);
  });

  it('an unreachable RDAP server is unknown { error }, warned once, not stored, and asked again once back', async () => {
    const rdap = await startRdap();
    const { port } = rdap;
    await new Promise(resolve => { rdap.server.closeAllConnections(); rdap.server.close(resolve); });
    // The bootstrap is fetched through a stand-in that knows where the registry server was.
    const bootstrapBody = JSON.stringify({ services: [[['com'], [`http://127.0.0.1:${port}/rdap/`]]] });
    const fetchFn = (url, init) => (url === 'https://bootstrap.test/dns.json'
      ? Promise.resolve(new Response(bootstrapBody, { status: 200 }))
      : fetch(url, init));
    const rep = reputation({ fetchFn, endpoints: { rdapBootstrap: 'https://bootstrap.test/dns.json' } });

    const down = await rep.lookupRdap(['alpha.com', 'bravo.com', 'charlie.com'], { deadlineMs: 5000 });
    for (const result of down.values()) expect(result).toEqual({ kind: 'unknown', reason: 'error' });
    expect(rep.database.writes()).toBe(0);
    expect(reputationLines('rdap')).toEqual(['[warn] [reputation] rdap lookup failed: endpoint unreachable']);

    await new Promise(resolve => rdap.server.listen(port, '127.0.0.1', resolve));
    const back = await rep.lookupRdap(['alpha.com'], { deadlineMs: 5000 });
    expect(back.get('alpha.com')).toEqual({ kind: 'known', registeredAt: '1997-04-28T04:00:00.000Z' });
    expect(lookedUp).toEqual(['alpha.com']);
    expect(rep.database.row('rdap', 'alpha.com').result).toEqual({ kind: 'known', registeredAt: '1997-04-28T04:00:00.000Z' });
  });

  it('a server that does not answer before the deadline is unknown { timeout }, warned once, not stored, and asked again', async () => {
    let hang = true;
    const rdap = await startRdap((name, response) => { if (!hang) sendJson(response, rdapDomain(name, '2001-02-03T00:00:00Z')); });
    const rep = reputation({ endpoints: { rdapBootstrap: `${rdap.base}/bootstrap/dns.json` } });

    const started = Date.now();
    const slow = await rep.lookupRdap(['slow.com', 'slower.com'], { deadlineMs: 400 });
    expect(Date.now() - started).toBeLessThan(2000);
    for (const result of slow.values()) expect(result).toEqual({ kind: 'unknown', reason: 'timeout' });
    expect(rep.database.writes()).toBe(0);
    expect(reputationLines('rdap')).toEqual(['[warn] [reputation] rdap lookup failed: deadline passed']);

    hang = false;
    const back = await rep.lookupRdap(['slow.com'], { deadlineMs: 5000 });
    expect(back.get('slow.com')).toEqual({ kind: 'known', registeredAt: '2001-02-03T00:00:00.000Z' });
    expect(lookedUp.filter(d => d === 'slow.com')).toHaveLength(2);
  });

  it('runs at most four RDAP requests at once and starts none after the deadline', async () => {
    let inFlight = 0;
    let most = 0;
    const rdap = await startRdap(() => { inFlight++; most = Math.max(most, inFlight); });
    const rep = reputation({ endpoints: { rdapBootstrap: `${rdap.base}/bootstrap/dns.json` } });
    const domains = ['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com', 'a6.com', 'a7.com'];
    const result = await rep.lookupRdap(domains, { deadlineMs: 400 });
    expect(most).toBe(4);
    expect(lookedUp).toHaveLength(4);
    for (const domain of domains) expect(result.get(domain)).toEqual({ kind: 'unknown', reason: 'timeout' });
  });

  it('a failed bootstrap fetch is an error for every domain, never unsupported_tld', async () => {
    const http = await startHttp((record, response) => sendJson(response, {}, 500));
    const rep = reputation({ endpoints: { rdapBootstrap: `${http.base}/bootstrap/dns.json` } });
    const result = await rep.lookupRdap(['one.com', 'two.org'], { deadlineMs: 5000 });
    for (const value of result.values()) expect(value).toEqual({ kind: 'unknown', reason: 'error' });
    expect(rep.database.writes()).toBe(0);
  });
});

describe('switch, keys and status', () => {
  const SOURCES = ['rdap', 'spamhaus_dbl', 'urlhaus', 'safe_browsing'];
  const statuses = async rep => Object.fromEntries(await Promise.all(SOURCES.map(async source => [source, await rep.sourceStatus(source)])));

  it('without keys the optional sources are unconfigured and nothing is logged or asked', async () => {
    const rdap = await startRdap();
    const rep = reputation({ endpoints: { rdapBootstrap: `${rdap.base}/bootstrap/dns.json` } });
    expect(await statuses(rep)).toEqual({ rdap: 'enabled', spamhaus_dbl: 'unconfigured', urlhaus: 'unconfigured', safe_browsing: 'unconfigured' });
    expect(await rep.lookupSpamhausDbl(['old.com'], { deadlineMs: 5000 })).toEqual(new Map([['old.com', { kind: 'unconfigured' }]]));
    expect(await rep.lookupUrlhaus(['old.com'], { deadlineMs: 5000 })).toEqual(new Map([['old.com', { kind: 'unconfigured' }]]));
    const urls = await rep.lookupSafeBrowsing(['https://example.com/a']);
    expect(urls).toEqual(new Map([['https://example.com/a', { kind: 'unconfigured' }]]));
    expect(rep.database.reads('spamhaus_dbl') + rep.database.reads('urlhaus') + rep.database.reads('safe_browsing')).toBe(0);
    await rep.lookupRdap(['old.com'], { deadlineMs: 5000 });
    expect(rdap.requests.map(r => r.url)).toEqual(['/bootstrap/dns.json', '/rdap/domain/old.com']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('with RDAP switched off the registration is unknown { disabled } and no RDAP request or cache read happens', async () => {
    const config = { ...RDAP_ONLY };
    const seen = [];
    const rdap = await startRdap();
    const rep = reputation({
      config: () => config,
      fetchFn: (url, init) => { seen.push(url); return fetch(url, init); },
      endpoints: { rdapBootstrap: `${rdap.base}/bootstrap/dns.json` },
    });
    await rep.lookupRdap(['old.com'], { deadlineMs: 5000 });
    expect(seen).toHaveLength(2);

    config.rdapEnabled = false;
    expect(await statuses(rep)).toEqual({ rdap: 'disabled', spamhaus_dbl: 'unconfigured', urlhaus: 'unconfigured', safe_browsing: 'unconfigured' });
    const readsBefore = rep.database.reads('rdap');
    const result = await rep.lookupRdap(['old.com', 'new.com'], { deadlineMs: 5000 });
    expect(result.get('old.com')).toEqual({ kind: 'unknown', reason: 'disabled' });
    expect(result.get('new.com')).toEqual({ kind: 'unknown', reason: 'disabled' });
    expect(seen).toHaveLength(2);
    expect(rep.database.reads('rdap')).toBe(readsBefore);
    expect(warn).not.toHaveBeenCalled();
  });

  it('status reports a source as enabled once its key is set', async () => {
    const rep = reputation({ config: { rdapEnabled: true, spamhausDqsKey: DQS_KEY, urlhausAuthKey: URLHAUS_KEY, safeBrowsingApiKey: SAFE_BROWSING_KEY } });
    expect(await statuses(rep)).toEqual({ rdap: 'enabled', spamhaus_dbl: 'enabled', urlhaus: 'enabled', safe_browsing: 'enabled' });
    await expect(rep.sourceStatus('whois')).rejects.toThrow('unknown reputation source "whois"');
  });

  it('rejects input that is not a registrable domain or an http(s) URL', async () => {
    const rep = reputation();
    for (const lookup of [rep.lookupRdap, rep.lookupSpamhausDbl, rep.lookupUrlhaus]) {
      await expect(lookup(['www.example.com'])).rejects.toThrow('domains[0] is not a registrable domain');
    }
    await expect(rep.lookupSafeBrowsing(['mailto:someone@example.com'])).rejects.toThrow('urls[0] is not an http(s) URL');
  });
});

describe('one function per source', () => {
  it('each lookup asks only its own service and reads and writes only its own cache rows', async () => {
    const rdap = await startRdap();
    const resolver = await startDns(() => ({ rcode: 3, soa: { ttl: 900, minimum: 60 } }));
    const urlhaus = await startHttp((record, response) => sendJson(response, { query_status: 'no_results' }));
    const safeBrowsing = await startHttp((record, response) => sendJson(response, { fullHashes: [], cacheDuration: '300s' }));
    const rep = reputation({
      config: { rdapEnabled: true, spamhausDqsKey: DQS_KEY, urlhausAuthKey: URLHAUS_KEY, safeBrowsingApiKey: SAFE_BROWSING_KEY },
      endpoints: {
        rdapBootstrap: `${rdap.base}/bootstrap/dns.json`,
        dnsServers: [resolver.server],
        urlhaus: `${urlhaus.base}/v1/host/`,
        safeBrowsing: `${safeBrowsing.base}/v5/hashes:search`,
      },
    });
    const traffic = () => ({
      rdap: rdap.requests.length,
      spamhaus_dbl: resolver.queries.length,
      urlhaus: urlhaus.requests.length,
      safe_browsing: safeBrowsing.requests.length,
    });
    const lookups = {
      rdap: () => rep.lookupRdap(['old.com'], { deadlineMs: 5000 }),
      spamhaus_dbl: () => rep.lookupSpamhausDbl(['old.com'], { deadlineMs: 5000 }),
      urlhaus: () => rep.lookupUrlhaus(['old.com'], { deadlineMs: 5000 }),
      safe_browsing: () => rep.lookupSafeBrowsing(['https://old.com/a'], { deadlineMs: 5000 }),
    };

    for (const [source, lookup] of Object.entries(lookups)) {
      const before = traffic();
      const from = rep.database.statementCount();
      await lookup();
      const after = traffic();
      const asked = Object.keys(after).filter(service => after[service] > before[service]);
      expect({ source, asked }).toEqual({ source, asked: [source] });
      expect({ source, touched: rep.database.sourcesSince(from) }).toEqual({ source, touched: [source] });
      expect({ source, written: rep.database.writtenSince(from) }).toEqual({ source, written: [source] });
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('only lookup services are contacted', () => {
  it('looking up the domains of a set of links asks IANA and the registry, never a link host', async () => {
    const links = [
      'https://login.secure-paypa1.com/verify?account=1',
      'http://shop.example.co.uk/deals/today',
      'https://cmbchina.com/',
      'https://tracking.mailer.cmbchina.com/click?id=9',
    ];
    const requested = [];
    const fetchFn = async url => {
      requested.push(url);
      if (url === 'https://data.iana.org/rdap/dns.json') {
        return new Response(JSON.stringify({ services: [[['com', 'uk'], ['https://rdap.registry.test/v1/']]] }), { status: 200 });
      }
      return new Response(JSON.stringify(rdapDomain('x', '1997-04-28T04:00:00Z')), { status: 200 });
    };
    const rep = reputation({ fetchFn });
    const domains = [...new Set(links.map(link => registrableDomain(hostOfUrl(link))))];
    expect(domains).toEqual(['secure-paypa1.com', 'example.co.uk', 'cmbchina.com']);
    await rep.lookupRdap(domains, { deadlineMs: 5000 });

    const hosts = new Set(requested.map(url => new URL(url).host));
    expect(hosts).toEqual(new Set(['data.iana.org', 'rdap.registry.test']));
    for (const link of links) expect(hosts.has(new URL(link).host)).toBe(false);
    expect(requested.filter(url => url.startsWith('https://rdap.registry.test/')).sort()).toEqual([
      'https://rdap.registry.test/v1/domain/cmbchina.com',
      'https://rdap.registry.test/v1/domain/example.co.uk',
      'https://rdap.registry.test/v1/domain/secure-paypa1.com',
    ]);
  });
});

describe('Spamhaus DBL and URLhaus', () => {
  const DBL_ANSWERS = {
    'hit.com': { addresses: [{ address: '127.0.1.4', ttl: 300 }] },
    'miss.com': { rcode: 3, soa: { ttl: 900, minimum: 60 } },
    'slow.com': 'drop',
    'broken.com': { rcode: 2 },
  };
  const URLHAUS_ANSWERS = {
    'hit.com': (response) => sendJson(response, { query_status: 'ok', urlhaus_reference: 'https://urlhaus.abuse.ch/host/hit.com/', host: 'hit.com', url_count: '12', urls: [] }),
    'miss.com': (response) => sendJson(response, { query_status: 'no_results' }),
    'slow.com': () => {},
    'broken.com': (response) => sendJson(response, { error: 'internal' }, 500),
  };

  async function sources() {
    const resolver = await startDns(name => DBL_ANSWERS[name.slice(0, name.indexOf(`.${DQS_KEY}.`))] ?? { rcode: 3 });
    const urlhaus = await startHttp((record, response) => URLHAUS_ANSWERS[new URLSearchParams(record.body).get('host')](response));
    const rep = reputation({
      config: { rdapEnabled: false, spamhausDqsKey: DQS_KEY, urlhausAuthKey: URLHAUS_KEY, safeBrowsingApiKey: null },
      endpoints: { dnsServers: [resolver.server], urlhaus: `${urlhaus.base}/v1/host/` },
    });
    return { resolver, urlhaus, rep };
  }

  // Both listings of each domain, asked side by side the way a caller of both sources does.
  async function listings(rep, domains, deadlineMs) {
    const [dbl, urlhaus] = await Promise.all([
      rep.lookupSpamhausDbl(domains, { deadlineMs }), rep.lookupUrlhaus(domains, { deadlineMs }),
    ]);
    return Object.fromEntries(domains.map(domain => [domain, { spamhaus_dbl: dbl.get(domain), urlhaus: urlhaus.get(domain) }]));
  }

  it('maps a listing, a miss, a timeout and a server failure, each by its own protocol', async () => {
    const { resolver, urlhaus, rep } = await sources();
    const result = await listings(rep, ['hit.com', 'miss.com', 'slow.com', 'broken.com'], 600);

    expect(result).toEqual({
      'hit.com': {
        spamhaus_dbl: { kind: 'listed', detail: 'phishing domain' },
        urlhaus: { kind: 'listed', detail: '12 malware URLs seen on this host' },
      },
      'miss.com': { spamhaus_dbl: { kind: 'not_listed' }, urlhaus: { kind: 'not_listed' } },
      'slow.com': { spamhaus_dbl: { kind: 'unknown', reason: 'timeout' }, urlhaus: { kind: 'unknown', reason: 'timeout' } },
      'broken.com': { spamhaus_dbl: { kind: 'unknown', reason: 'error' }, urlhaus: { kind: 'unknown', reason: 'error' } },
    });

    expect(resolver.queries.map(q => q.name).sort()).toEqual(
      ['broken.com', 'hit.com', 'miss.com', 'slow.com'].map(d => `${d}.${DQS_KEY}.dbl.dq.spamhaus.net`),
    );
    expect(resolver.queries.every(q => q.type === 1)).toBe(true);
    expect(urlhaus.requests).toHaveLength(4);
    for (const request of urlhaus.requests) {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v1/host/');
      expect(request.headers['auth-key']).toBe(URLHAUS_KEY);
      expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    }
    expect(urlhaus.requests.map(r => r.body).sort()).toEqual(['host=broken.com', 'host=hit.com', 'host=miss.com', 'host=slow.com']);

    // DBL: a listing for its answer's TTL, a miss for the negative TTL min(SOA TTL, MINIMUM).
    expect(rep.database.row('spamhaus_dbl', 'hit.com')).toMatchObject({ fetched_at: new Date(START), expires_at: new Date(START + 300 * SECOND) });
    expect(rep.database.row('spamhaus_dbl', 'miss.com')).toMatchObject({ fetched_at: new Date(START), expires_at: new Date(START + 60 * SECOND) });
    expect(rep.database.row('urlhaus', 'hit.com')).toMatchObject({ expires_at: new Date(START + 60 * MINUTE) });
    expect(rep.database.row('urlhaus', 'miss.com')).toMatchObject({ expires_at: new Date(START + 60 * MINUTE) });
    for (const source of ['spamhaus_dbl', 'urlhaus']) {
      expect(rep.database.row(source, 'slow.com')).toBeUndefined();
      expect(rep.database.row(source, 'broken.com')).toBeUndefined();
    }
    expect(reputationLines('spamhaus_dbl')).toHaveLength(1);
    expect(reputationLines('urlhaus')).toHaveLength(1);
  });

  it('serves cached verdicts until they expire, then asks again', async () => {
    const { resolver, urlhaus, rep } = await sources();
    await listings(rep, ['hit.com', 'miss.com'], 2000);
    expect(resolver.queries).toHaveLength(2);
    expect(urlhaus.requests).toHaveLength(2);

    clock = START + 59 * SECOND;
    await listings(rep, ['hit.com', 'miss.com'], 2000);
    expect(resolver.queries).toHaveLength(2);
    expect(urlhaus.requests).toHaveLength(2);

    // Past the DBL miss's 60 s; the listing's 300 s and URLhaus's hour still hold.
    clock = START + 61 * SECOND;
    await listings(rep, ['hit.com', 'miss.com'], 2000);
    expect(resolver.queries.map(q => q.name.split('.')[0])).toEqual(expect.arrayContaining(['hit', 'miss']));
    expect(resolver.queries).toHaveLength(3);
    expect(urlhaus.requests).toHaveLength(2);

    clock = START + 61 * MINUTE;
    await listings(rep, ['hit.com', 'miss.com'], 2000);
    expect(urlhaus.requests).toHaveLength(4);
  });

  it('treats the service\'s error codes as unknown, never as a listing', async () => {
    const resolver = await startDns(name => (name.startsWith('flood.')
      ? { addresses: [{ address: '127.255.255.255', ttl: 60 }] }
      : name.startsWith('public.')
        ? { addresses: [{ address: '127.255.255.254', ttl: 60 }] }
        : { rcode: 3 }));
    const rep = reputation({
      config: { rdapEnabled: false, spamhausDqsKey: DQS_KEY, urlhausAuthKey: null, safeBrowsingApiKey: null },
      endpoints: { dnsServers: [resolver.server] },
    });
    const result = await rep.lookupSpamhausDbl(['flood.com', 'public.com', 'nosoa.com'], { deadlineMs: 2000 });
    expect(result.get('flood.com')).toEqual({ kind: 'unknown', reason: 'rate_limited' });
    expect(result.get('public.com')).toEqual({ kind: 'unknown', reason: 'error' });
    // NXDOMAIN without an SOA: not listed, but with no TTL to keep it for.
    expect(result.get('nosoa.com')).toEqual({ kind: 'not_listed' });
    expect(rep.database.writes()).toBe(0);
  });
});

describe('Google Safe Browsing', () => {
  const hashOf = expression => expressionHash(expression).toString('base64');
  const DATABASE = new Map([
    [hashOf('phish-example.com/'), [{ threatType: 'SOCIAL_ENGINEERING', attributes: [] }]],
    [hashOf('canary-example.com/'), [{ threatType: 'MALWARE', attributes: ['CANARY'] }]],
  ]);

  async function startSafeBrowsing(cacheDuration = '3600s') {
    let mode = 'answer';
    const http = await startHttp((record, response) => {
      if (mode === 'hang') return;
      if (mode === 'fail') { sendJson(response, { error: { code: 500 } }, 500); return; }
      const prefixes = new URL(record.url, http.base).searchParams.getAll('hashPrefixes');
      const fullHashes = [...DATABASE]
        .filter(([full]) => prefixes.includes(Buffer.from(full, 'base64').subarray(0, 4).toString('base64')))
        .map(([fullHash, fullHashDetails]) => ({ fullHash, fullHashDetails }));
      sendJson(response, { fullHashes, cacheDuration });
    });
    return { ...http, setMode: next => { mode = next; } };
  }

  const config = { rdapEnabled: true, spamhausDqsKey: null, urlhausAuthKey: null, safeBrowsingApiKey: SAFE_BROWSING_KEY };
  const HIT = 'https://login.phish-example.com/account/verify?id=1#top';
  const MISS = 'https://clean-example.com/a/b.html';
  const CANARY = 'http://canary-example.com/x';

  it('sends only 4-byte hash prefixes and matches the full hashes locally', async () => {
    const sb = await startSafeBrowsing();
    const rep = reputation({ config, endpoints: { safeBrowsing: `${sb.base}/v5/hashes:search` } });
    const result = await rep.lookupSafeBrowsing([HIT, MISS, CANARY], { deadlineMs: 5000 });

    expect(result).toEqual(new Map([
      [HIT, { kind: 'listed', detail: 'SOCIAL_ENGINEERING' }],
      [MISS, { kind: 'not_listed' }],
      [CANARY, { kind: 'not_listed' }],
    ]));
    expect(sb.requests).toHaveLength(1);
    const [request] = sb.requests;
    const url = new URL(request.url, sb.base);
    expect(request.method).toBe('GET');
    expect(url.pathname).toBe('/v5/hashes:search');
    expect([...new Set(url.searchParams.keys())]).toEqual(['hashPrefixes']);
    expect(request.headers['x-goog-api-key']).toBe(SAFE_BROWSING_KEY);
    expect(request.body).toBe('');
    const expected = new Set([HIT, MISS, CANARY].flatMap(u => urlExpressions(u).expressions)
      .map(e => expressionHash(e).subarray(0, 4).toString('base64')));
    const sent = url.searchParams.getAll('hashPrefixes');
    expect(new Set(sent)).toEqual(expected);
    expect(sent.every(prefix => Buffer.from(prefix, 'base64').length === 4)).toBe(true);
    for (const text of ['phish-example', 'clean-example', 'canary-example', 'account', 'verify', 'b.html']) {
      expect(request.url).not.toContain(text);
      expect(JSON.stringify(request.headers)).not.toContain(text);
    }
    expect(rep.database.row('safe_browsing', 'login.phish-example.com/account/verify?id=1'))
      .toMatchObject({ fetched_at: new Date(START), expires_at: new Date(START + 3600 * SECOND) });
    expect(rep.database.row('safe_browsing', 'clean-example.com/a/b.html'))
      .toMatchObject({ expires_at: new Date(START + 3600 * SECOND) });
  });

  // Encoded independently with protoc from the official v5 field numbers. The synthetic hash is
  // SHA-256('phish-example.com/'); Duration is { seconds: 3600, nanos: 123456789 }.
  const PROTO_HASH = '0a207b5bcaac8021558595e6b4bbc8809f1371c2c720b5a2b2652e6427809a620d74';
  const PROTO_DURATION = '120808901c10959aef3a';
  const PROTO_HIT = `0a26${PROTO_HASH}12020802${PROTO_DURATION}`;

  async function protobufSource(hex) {
    const sb = await startHttp((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'Application/X-Protobuf; charset=binary' });
      response.end(Buffer.from(hex, 'hex'));
    });
    return { sb, rep: reputation({ config, endpoints: { safeBrowsing: `${sb.base}/v5/hashes:search` } }) };
  }

  it('decodes protobuf bytes, matches full hashes, applies fractional TTL and serves a cached repeat', async () => {
    const { sb, rep } = await protobufSource(PROTO_HIT);
    const expected = new Map([[HIT, { kind: 'listed', detail: 'SOCIAL_ENGINEERING' }], [MISS, { kind: 'not_listed' }]]);
    expect(await rep.lookupSafeBrowsing([HIT, MISS])).toEqual(expected);
    for (const subject of ['login.phish-example.com/account/verify?id=1', 'clean-example.com/a/b.html']) {
      expect(rep.database.row('safe_browsing', subject).expires_at).toEqual(new Date(START + 3600123));
    }
    expect(await rep.lookupSafeBrowsing([HIT, MISS])).toEqual(expected);
    expect(sb.requests).toHaveLength(1);
    clock = START + 31 * MINUTE;
    expect((await rep.lookupSafeBrowsing([HIT, MISS])).get(HIT)).toEqual(expected.get(HIT));
    expect(sb.requests).toHaveLength(2);
    clock = START + 3600124;
    await rep.lookupSafeBrowsing([MISS]);
    expect(sb.requests).toHaveLength(3);
  });

  it('accepts an omitted full_hashes list and a zero protobuf duration without caching it', async () => {
    const { rep } = await protobufSource('1200');
    expect((await rep.lookupSafeBrowsing([HIT])).get(HIT)).toEqual({ kind: 'not_listed' });
    expect(rep.database.writes()).toBe(0);
  });

  it.each([
    ['CANARY', `0a29${PROTO_HASH}12050802120101${PROTO_DURATION}`],
    ['FRAME_ONLY', `0a29${PROTO_HASH}12050802120102${PROTO_DURATION}`],
    ['unknown threat', `0a26${PROTO_HASH}12020863${PROTO_DURATION}`],
    ['unknown attribute', `0a29${PROTO_HASH}12050802120163${PROTO_DURATION}`],
    ['unspecified attribute', `0a29${PROTO_HASH}12050802120100${PROTO_DURATION}`],
    ['unpacked CANARY', `0a28${PROTO_HASH}120408021001${PROTO_DURATION}`],
    ['default threat', `0a24${PROTO_HASH}1200${PROTO_DURATION}`],
  ])('disregards %s in protobuf without treating the response as a failure', async (_name, hex) => {
    const { rep } = await protobufSource(hex);
    expect((await rep.lookupSafeBrowsing([HIT])).get(HIT)).toEqual({ kind: 'not_listed' });
    expect(rep.database.row('safe_browsing', 'login.phish-example.com/account/verify?id=1').expires_at).toEqual(new Date(START + 3600123));
    expect(reputationLines('safe_browsing')).toEqual([]);
  });

  it('skips unknown fields of every supported wire type and merges repeated Duration messages', async () => {
    // Unknown fields #3 (varint), #4 (fixed64), #5 (bytes), #6 (fixed32) precede the answer.
    const unknownFields = '18ffffffffffffffffff012100000000000000002a02ff003500000000';
    const { rep } = await protobufSource(`${unknownFields}0a28${PROTO_HASH}120408021801120308901c120510959aef3a`);
    expect((await rep.lookupSafeBrowsing([HIT])).get(HIT)).toEqual({ kind: 'listed', detail: 'SOCIAL_ENGINEERING' });
    expect(rep.database.row('safe_browsing', 'login.phish-example.com/account/verify?id=1').expires_at).toEqual(new Date(START + 3600123));
  });

  it.each([
    ['80', 'SearchHashesResponse: truncated varint'],
    ['ffffffffffffffffffff02', 'SearchHashesResponse: varint exceeds uint64'],
    ['00', 'SearchHashesResponse: invalid field tag'],
    ['0b', 'SearchHashesResponse: unsupported wire type'],
    ['0a80', 'SearchHashesResponse: truncated varint'],
    ['0a05ff', 'SearchHashesResponse: truncated length-delimited or fixed-width field'],
    ['1900', 'SearchHashesResponse: truncated length-delimited or fixed-width field'],
    ['0801', 'SearchHashesResponse: wrong wire type for field 1'],
    ['0a020a00', 'FullHash: invalid fullHash length (expected 32 bytes)'],
    [`0a26${PROTO_HASH}12020880`, 'FullHashDetail: truncated varint'],
    [PROTO_HIT.slice(0, -2), 'SearchHashesResponse: truncated length-delimited or fixed-width field'],
    [`0a26${PROTO_HASH}12020802`, 'SearchHashesResponse: missing cacheDuration'],
    ['120b08ffffffffffffffffff01', 'SearchHashesResponse: invalid cacheDuration seconds or nanos'],
    ['12061080c2d72f', 'SearchHashesResponse: truncated length-delimited or fixed-width field'],
    ['1206108080808010', 'SearchHashesResponse: invalid cacheDuration seconds or nanos'],
    ['1206108094ebdc03', 'SearchHashesResponse: invalid cacheDuration seconds or nanos'],
    ['12020880', 'Duration: truncated varint'],
  ])('rejects malformed protobuf %s with a bounded diagnostic and no cached answer', async (hex, diagnostic) => {
    const { sb, rep } = await protobufSource(hex);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await rep.lookupSafeBrowsing([HIT])).get(HIT)).toEqual({ kind: 'unknown', reason: 'error' });
    }
    expect(sb.requests).toHaveLength(2);
    expect(rep.database.writes()).toBe(0);
    expect(reputationLines('safe_browsing')).toEqual([`[warn] [reputation] safe_browsing lookup failed: protobuf ${diagnostic}`]);
  });

  it.each([
    ['text/html', '<html>upstream error</html>', 'unsupported response Content-Type'],
    ['application/json', '{"fullHashes":', 'JSON response: malformed JSON'],
    ['application/json', '{"cacheDuration":"bad"}', 'JSON response: invalid cacheDuration'],
    ['application/json', '{"cacheDuration":"300s","fullHashes":42}', 'JSON response: invalid fullHashes'],
  ])('returns unknown without caching a bad %s response, and logs only the parsing step', async (contentType, body, diagnostic) => {
    const sb = await startHttp((_request, response) => {
      response.writeHead(200, { 'Content-Type': contentType });
      response.end(body);
    });
    const rep = reputation({ config, endpoints: { safeBrowsing: `${sb.base}/v5/hashes:search` } });
    expect((await rep.lookupSafeBrowsing([HIT])).get(HIT)).toEqual({ kind: 'unknown', reason: 'error' });
    expect(rep.database.writes()).toBe(0);
    const lines = reputationLines('safe_browsing');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(diagnostic);
    for (const secret of [...KEYS, HIT, body]) expect(lines[0]).not.toContain(secret);
  });

  it('asks again for a cached listing older than 30 minutes, and for anything past its cacheDuration', async () => {
    const sb = await startSafeBrowsing();
    const rep = reputation({ config, endpoints: { safeBrowsing: `${sb.base}/v5/hashes:search` } });
    await rep.lookupSafeBrowsing([HIT, MISS], { deadlineMs: 5000 });
    expect(sb.requests).toHaveLength(1);

    clock = START + 29 * MINUTE;
    await rep.lookupSafeBrowsing([HIT, MISS], { deadlineMs: 5000 });
    expect(sb.requests).toHaveLength(1);

    // Within the hour of cacheDuration, but the listing is 31 minutes old: asked again; the
    // miss is still served from the cache.
    clock = START + 31 * MINUTE;
    const again = await rep.lookupSafeBrowsing([HIT, MISS], { deadlineMs: 5000 });
    expect(sb.requests).toHaveLength(2);
    expect(again.get(HIT)).toEqual({ kind: 'listed', detail: 'SOCIAL_ENGINEERING' });
    const prefixesOf = request => new URL(request.url, sb.base).searchParams.getAll('hashPrefixes');
    expect(new Set(prefixesOf(sb.requests[1]))).toEqual(new Set(urlExpressions(HIT).expressions.map(e => expressionHash(e).subarray(0, 4).toString('base64'))));
    expect(rep.database.row('safe_browsing', 'login.phish-example.com/account/verify?id=1').fetched_at).toEqual(new Date(START + 31 * MINUTE));

    // A refetch that fails does not fall back to the old listing.
    sb.setMode('fail');
    clock = START + 62 * MINUTE;
    const failed = await rep.lookupSafeBrowsing([HIT, MISS], { deadlineMs: 5000 });
    expect(failed.get(HIT)).toEqual({ kind: 'unknown', reason: 'error' });
    expect(failed.get(MISS)).toEqual({ kind: 'unknown', reason: 'error' });
  });

  it('a request past the deadline is unknown { timeout } and an HTTP 500 unknown { error }, neither stored', async () => {
    const sb = await startSafeBrowsing();
    const rep = reputation({ config, endpoints: { safeBrowsing: `${sb.base}/v5/hashes:search` } });
    sb.setMode('hang');
    const slow = await rep.lookupSafeBrowsing([HIT], { deadlineMs: 300 });
    expect(slow.get(HIT)).toEqual({ kind: 'unknown', reason: 'timeout' });
    sb.setMode('fail');
    const failed = await rep.lookupSafeBrowsing([MISS], { deadlineMs: 5000 });
    expect(failed.get(MISS)).toEqual({ kind: 'unknown', reason: 'error' });
    expect(rep.database.writes()).toBe(0);
    // One line per source per minute: the HTTP 500 right after the timeout is counted, not logged.
    expect(reputationLines('safe_browsing')).toEqual(['[warn] [reputation] safe_browsing lookup failed: deadline passed']);
  });

  it('two links with the same canonical form share one lookup and each keeps its own key', async () => {
    const sb = await startSafeBrowsing('300s');
    const rep = reputation({ config, endpoints: { safeBrowsing: `${sb.base}/v5/hashes:search` } });
    const a = 'https://Login.Phish-Example.com/account/verify?id=1';
    const b = 'https://login.phish-example.com/account/./verify?id=1#frag';
    const result = await rep.lookupSafeBrowsing([a, b], { deadlineMs: 5000 });
    expect(result.get(a)).toEqual(result.get(b));
    expect(result.get(a).kind).toBe('listed');
    expect(rep.database.row('safe_browsing', 'login.phish-example.com/account/verify?id=1').expires_at).toEqual(new Date(START + 300 * SECOND));
  });
});

describe('Safe Browsing URL expressions', () => {
  it('forms the host-suffix/path-prefix combinations of the published examples', () => {
    expect(new Set(urlExpressions('http://a.b.com/1/2.html?param=1').expressions)).toEqual(new Set([
      'a.b.com/1/2.html?param=1', 'a.b.com/1/2.html', 'a.b.com/', 'a.b.com/1/',
      'b.com/1/2.html?param=1', 'b.com/1/2.html', 'b.com/', 'b.com/1/',
    ]));
    expect(new Set(urlExpressions('http://a.b.c.d.e.f.com/1.html').expressions)).toEqual(new Set([
      'a.b.c.d.e.f.com/1.html', 'a.b.c.d.e.f.com/', 'c.d.e.f.com/1.html', 'c.d.e.f.com/',
      'd.e.f.com/1.html', 'd.e.f.com/', 'e.f.com/1.html', 'e.f.com/', 'f.com/1.html', 'f.com/',
    ]));
    expect(new Set(urlExpressions('http://1.2.3.4/1/').expressions)).toEqual(new Set(['1.2.3.4/1/', '1.2.3.4/']));
    expect(new Set(urlExpressions('http://example.co.uk/1').expressions)).toEqual(new Set(['example.co.uk/1', 'example.co.uk/']));
  });

  it('canonicalizes the URL first', () => {
    const canonical = url => urlExpressions(url).canonical;
    expect(canonical('http://host/%25%32%35')).toBe('host/%25');
    expect(canonical('http://www.GOOgle.com/')).toBe('www.google.com/');
    expect(canonical('http://3279880203/blah')).toBe('195.127.0.11/blah');
    expect(canonical('http://www.google.com/blah/..')).toBe('www.google.com/');
    expect(canonical('http://www.google.com/foo\tbar\rbaz\n2')).toBe('www.google.com/foobarbaz2');
    expect(canonical('http://www.google.com/q?')).toBe('www.google.com/q?');
    expect(canonical('http://www.google.com/q?r?s')).toBe('www.google.com/q?r?s');
    expect(canonical('http://evil.com/foo#bar#baz')).toBe('evil.com/foo');
    expect(canonical('http://www.google.com/foo//bar')).toBe('www.google.com/foo/bar');
    expect(canonical('http://www.gotaport.com:1234/')).toBe('www.gotaport.com/');
    expect(canonical('http://[::ffff:1.2.3.4]/')).toBe('1.2.3.4/');
    expect(canonical('http://\u4f8b\u5b50.\u4e2d\u56fd/%E4%BE%8B')).toBe('xn--fsqu00a.xn--fiqs8s/%E4%BE%8B');
  });
});
