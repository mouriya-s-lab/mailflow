// Domain and URL reputation from outside lookup services (contract K6 in mouriya-s-lab/mailflow#5):
// RDAP registration dates, Spamhaus DBL and URLhaus listings for registrable domains, and Google
// Safe Browsing for link URLs. Only the lookup services are contacted, never a link itself.
//
// Every failure of an outside service is a value, `unknown { reason }`, and a logger.warn limited
// to one line per source per minute; nothing here reads a failure as "not listed". A source
// without its key is `unconfigured` and is reported by status(), not logged per request. The RDAP
// switch and the keys come from the admin setting (fork-features/service-config) on every call.
//
// Answers are kept in fork_reputation_cache, a copy of what the service said: each row expires
// after the source's own lifetime and is fetched again after that. Failed lookups are never stored.
// Neither keys nor the domains and URLs looked up reach a log line.

import dns from 'node:dns';
import { logger } from '../../src/services/logger.js';
import { query } from '../../src/services/db.js';
import { safeFetch } from '../../src/services/safeFetch.js';
import { getReputationConfig } from '../service-config/index.js';
import { hostOfUrl, registrableDomain } from '../domains/index.js';
import { queryA } from './dnsQuery.js';
import { expressionHash, urlExpressions } from './safeBrowsing.js';

// The services' official endpoints; createReputation accepts others only so tests can stand in.
export const REPUTATION_ENDPOINTS = Object.freeze({
  rdapBootstrap: 'https://data.iana.org/rdap/dns.json',
  dblZone: 'dbl.dq.spamhaus.net',
  dnsServers: null, // the system's resolvers, dns.getServers()
  urlhaus: 'https://urlhaus-api.abuse.ch/v1/host/',
  safeBrowsing: 'https://safebrowsing.googleapis.com/v5/hashes:search',
});

const SOURCE_TIMEOUT_MS = 5000;
const CONCURRENCY = { rdap: 4, spamhaus_dbl: 8, urlhaus: 4, safe_browsing: 2 };
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const RDAP_KNOWN_TTL_MS = 30 * DAY_MS;
const RDAP_NOT_FOUND_TTL_MS = DAY_MS;
const URLHAUS_TTL_MS = 60 * MINUTE_MS;
// A cached Safe Browsing listing older than this is asked again before it is reported.
const SAFE_BROWSING_LISTED_FRESH_MS = 30 * MINUTE_MS;
// IANA's bootstrap file changes when a registry moves its RDAP service; a day-old copy is fine.
const BOOTSTRAP_TTL_MS = DAY_MS;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BOOTSTRAP_BYTES = 4 * 1024 * 1024;
const SAFE_BROWSING_MAX_PREFIXES = 1000;
const WARN_INTERVAL_MS = MINUTE_MS;
// setTimeout's longest delay; a lookup without deadlineMs waits at most this long for a slot.
const MAX_TIMER_MS = 2 ** 31 - 1;

// DBL answers in 127.0.1.2-127.0.1.199 are listings (100-199: compromised legitimate domains);
// 127.255.255.x are errors from the service, never listings.
const DBL_LISTINGS = {
  '127.0.1.2': 'spam domain',
  '127.0.1.4': 'phishing domain',
  '127.0.1.5': 'malware domain',
  '127.0.1.6': 'botnet C&C domain',
  '127.0.1.102': 'abused legitimate spam domain',
  '127.0.1.103': 'abused spammed redirector domain',
  '127.0.1.104': 'abused legitimate phishing domain',
  '127.0.1.105': 'abused legitimate malware domain',
  '127.0.1.106': 'abused legitimate botnet C&C domain',
};
const DBL_EXCESSIVE_QUERIES = '127.255.255.255';
const DNS_NOERROR = 0;
const DNS_NXDOMAIN = 3;

const SAFE_BROWSING_THREATS = new Set(['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION']);

const unknown = reason => ({ kind: 'unknown', reason });
const listed = detail => ({ kind: 'listed', detail });
const NOT_LISTED = Object.freeze({ kind: 'not_listed' });
const UNCONFIGURED = Object.freeze({ kind: 'unconfigured' });

// What one lookup produced: the verdict, how long it may be cached (null: not at all) and, for an
// outside failure, the warning text.
const outcome = (result, ttlMs = null) => ({ result, ttlMs, warning: null });
const failure = (reason, warning) => ({ result: unknown(reason), ttlMs: null, warning });
const DEADLINE_PASSED = failure('timeout', 'deadline passed');

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// A cached row is MailFlow's own JSON, but it is still read back into the exact result types.
function parseCached(source, value) {
  switch (source) {
    case 'rdap':
      if (value?.kind === 'known' && typeof value.registeredAt === 'string') return { kind: 'known', registeredAt: value.registeredAt };
      if (value?.kind === 'not_found') return { kind: 'not_found' };
      break;
    case 'spamhaus_dbl':
    case 'urlhaus':
    case 'safe_browsing':
      if (value?.kind === 'listed' && typeof value.detail === 'string') return listed(value.detail);
      if (value?.kind === 'not_listed') return NOT_LISTED;
      break;
    default:
      throw new Error(`unknown reputation source ${source}`);
  }
  throw new Error(`fork_reputation_cache holds an invalid ${source} result`);
}

// ── Transport ─────────────────────────────────────────────────────────────────

// Reads at most maxBytes; null past that, which also cancels the stream.
async function readBody(body, maxBytes) {
  if (!body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      await body.cancel?.().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// One HTTP exchange within timeoutMs: the status and the body, or a failure outcome. Never throws
// for anything the network or the server does.
async function exchange(fetchFn, url, init, timeoutMs, maxBytes = MAX_BODY_BYTES) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    const body = await readBody(response.body, maxBytes);
    if (body === null) return { kind: 'failed', failure: failure('error', 'response body too large') };
    return { kind: 'response', status: response.status, body };
  } catch {
    return { kind: 'failed', failure: timedOut ? DEADLINE_PASSED : failure('error', 'endpoint unreachable') };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(body) {
  try { return JSON.parse(body.toString('utf8')); } catch { return undefined; }
}

// A non-200 answer: 429 is rate limiting, anything else an error.
const httpFailure = status => (status === 429 ? failure('rate_limited', 'HTTP 429') : failure('error', `HTTP ${status}`));

// At most `max` tasks at once per source, shared by every concurrent lookup. A task that cannot
// start before deadlineAt is not started; one that starts gets the source's 5 s, or what is left
// before deadlineAt if that is less.
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next.grant();
    else active--;
  };
  const acquire = deadlineAt => {
    if (active < max) {
      active++;
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      const entry = {
        grant: () => { clearTimeout(entry.timer); resolve(true); },
        timer: setTimeout(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          resolve(false);
        }, Math.min(Math.max(0, deadlineAt - Date.now()), MAX_TIMER_MS)),
      };
      waiting.push(entry);
    });
  };
  return async (deadlineAt, task) => {
    if (deadlineAt <= Date.now() || !(await acquire(deadlineAt))) return DEADLINE_PASSED;
    try {
      const timeoutMs = Math.min(SOURCE_TIMEOUT_MS, deadlineAt - Date.now());
      return timeoutMs > 0 ? await task(timeoutMs) : DEADLINE_PASSED;
    } finally {
      release();
    }
  };
}

// The threat types a Safe Browsing full hash carries. A detail with an unknown threat type or any
// attribute is disregarded: unknown values void the detail by the API's rule, CANARY must not be
// enforced, and FRAME_ONLY applies only inside frames, never to a link someone opens.
function threatTypes(fullHash) {
  const types = new Set();
  for (const detail of Array.isArray(fullHash.fullHashDetails) ? fullHash.fullHashDetails : []) {
    if (!isRecord(detail) || !SAFE_BROWSING_THREATS.has(detail.threatType)) continue;
    if (Array.isArray(detail.attributes) && detail.attributes.length > 0) continue;
    types.add(detail.threatType);
  }
  return types;
}

// "300s" or "3.5s" in milliseconds; null for anything else.
function parseDuration(value) {
  const match = typeof value === 'string' ? /^(\d+)(?:\.(\d{1,9}))?s$/.exec(value) : null;
  if (!match) return null;
  return Number(match[1]) * 1000 + Math.floor(Number(`0.${match[2] ?? '0'}`) * 1000);
}

// ── Module ────────────────────────────────────────────────────────────────────

// The plugin API builds the default instance on import, so each dependency is looked up per call.
export function createReputation({
  queryFn = (...args) => query(...args),
  getConfigFn = () => getReputationConfig(),
  fetchFn = (url, init) => safeFetch(url, init),
  endpoints: endpointOverrides = {},
  now = () => Date.now(),
} = {}) {
  const endpoints = { ...REPUTATION_ENDPOINTS, ...endpointOverrides };
  const limiters = Object.fromEntries(Object.entries(CONCURRENCY).map(([source, max]) => [source, createLimiter(max)]));
  const lastWarned = new Map();

  function warn(source, line) {
    const at = Date.now();
    const previous = lastWarned.get(source);
    if (previous && at - previous.at < WARN_INTERVAL_MS) {
      previous.suppressed++;
      return;
    }
    lastWarned.set(source, { at, suppressed: 0 });
    const suppressed = previous?.suppressed ? ` (${previous.suppressed} more since the last warning)` : '';
    logger.warn(`[reputation] ${source} lookup failed: ${line}${suppressed}`);
  }

  // ── Cache ──

  async function readCache(source, subjects) {
    const { rows } = await queryFn(
      `SELECT subject, result, fetched_at FROM fork_reputation_cache
       WHERE source = $1 AND subject = ANY($2::text[]) AND expires_at > $3`,
      [source, subjects, new Date(now())],
    );
    return new Map(rows.map(row => [row.subject, {
      result: parseCached(source, row.result),
      fetchedAt: new Date(row.fetched_at).getTime(),
    }]));
  }

  async function writeCache(source, entries) {
    if (entries.length === 0) return;
    await queryFn(
      `INSERT INTO fork_reputation_cache (source, subject, result, fetched_at, expires_at)
       SELECT $1, e.subject, e.result, e.fetched_at, e.expires_at
       FROM unnest($2::text[], $3::jsonb[], $4::timestamptz[], $5::timestamptz[])
         AS e(subject, result, fetched_at, expires_at)
       ON CONFLICT (source, subject) DO UPDATE
         SET result = EXCLUDED.result, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
      [
        source,
        entries.map(e => e.subject),
        entries.map(e => JSON.stringify(e.result)),
        entries.map(e => new Date(e.fetchedAt)),
        entries.map(e => new Date(e.fetchedAt + e.ttlMs)),
      ],
    );
  }

  // Cached answers where `usable`, and `fetchMissing(subjects, deadlineAt)` → Map<subject, outcome>
  // for the rest; outcomes with a lifetime are stored, failures warned.
  async function cachedLookup(source, subjects, deadlineAt, fetchMissing, usable = () => true) {
    const cached = await readCache(source, subjects);
    const results = new Map();
    const missing = [];
    for (const subject of subjects) {
      const row = cached.get(subject);
      if (row && usable(row)) results.set(subject, row.result);
      else missing.push(subject);
    }
    if (missing.length === 0) return results;
    const fetched = await fetchMissing(missing, deadlineAt);
    const fetchedAt = now();
    const store = [];
    for (const subject of missing) {
      const { result, ttlMs, warning } = fetched.get(subject);
      results.set(subject, result);
      if (warning) warn(source, warning);
      if (ttlMs > 0) store.push({ subject, result, fetchedAt, ttlMs });
    }
    await writeCache(source, store);
    return results;
  }

  // One limited lookup per subject.
  const eachLimited = (source, lookupOne) => async (subjects, deadlineAt) => {
    const limit = limiters[source];
    const outcomes = await Promise.all(subjects.map(subject => limit(deadlineAt, timeoutMs => lookupOne(subject, timeoutMs))));
    return new Map(subjects.map((subject, i) => [subject, outcomes[i]]));
  };

  // ── RDAP ──
  // IANA's bootstrap file maps each TLD to its registry's RDAP base URL. It is held in memory: a
  // copy of data.iana.org, replaced once it is a day old, fetched once for concurrent callers,
  // and not kept when the fetch fails.

  let bootstrap = null; // { services: Map<tld, baseUrl>, fetchedAt }
  let bootstrapLoad = null;

  async function fetchBootstrap() {
    const answer = await exchange(fetchFn, endpoints.rdapBootstrap, { headers: { Accept: 'application/json' } },
      SOURCE_TIMEOUT_MS, MAX_BOOTSTRAP_BYTES);
    if (answer.kind === 'failed') return answer.failure;
    if (answer.status !== 200) return httpFailure(answer.status);
    const parsed = parseJson(answer.body);
    if (!isRecord(parsed) || !Array.isArray(parsed.services)) return failure('error', 'invalid bootstrap file');
    const services = new Map();
    for (const service of parsed.services) {
      if (!Array.isArray(service) || !Array.isArray(service[0]) || !Array.isArray(service[1])) continue;
      const urls = service[1].filter(url => typeof url === 'string');
      const base = urls.find(url => url.startsWith('https://')) ?? urls[0];
      if (!base) continue;
      for (const tld of service[0]) if (typeof tld === 'string') services.set(tld.toLowerCase(), base);
    }
    bootstrap = { services, fetchedAt: now() };
    return null;
  }

  // The bootstrap services, or the failure outcome every domain of this lookup gets.
  async function rdapServices(deadlineAt) {
    if (bootstrap && now() - bootstrap.fetchedAt < BOOTSTRAP_TTL_MS) return bootstrap.services;
    if (deadlineAt <= Date.now()) return DEADLINE_PASSED;
    bootstrapLoad ??= fetchBootstrap().finally(() => { bootstrapLoad = null; });
    let timer;
    const late = new Promise(resolve => {
      timer = setTimeout(() => resolve(DEADLINE_PASSED), Math.min(deadlineAt - Date.now(), MAX_TIMER_MS));
    });
    try {
      const failed = await Promise.race([bootstrapLoad, late]);
      return failed ?? bootstrap.services;
    } finally {
      clearTimeout(timer);
    }
  }

  function parseRegistration(body) {
    const parsed = parseJson(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.events)) return failure('error', 'invalid response');
    for (const event of parsed.events) {
      if (!isRecord(event) || event.eventAction !== 'registration' || typeof event.eventDate !== 'string') continue;
      const at = Date.parse(event.eventDate);
      if (!Number.isNaN(at)) return outcome({ kind: 'known', registeredAt: new Date(at).toISOString() }, RDAP_KNOWN_TTL_MS);
    }
    // Some registries publish no registration date; that says nothing about the domain's age.
    return failure('error', 'no registration date in the response');
  }

  async function rdapLookup(domains, deadlineAt) {
    const services = await rdapServices(deadlineAt);
    if (!(services instanceof Map)) return new Map(domains.map(domain => [domain, services]));
    return eachLimited('rdap', async (domain, timeoutMs) => {
      const base = services.get(domain.slice(domain.lastIndexOf('.') + 1));
      // Not stored: the TLD may gain an RDAP service any day. Not an outside failure either.
      if (!base) return outcome(unknown('unsupported_tld'));
      const url = new URL(`domain/${domain}`, base.endsWith('/') ? base : `${base}/`);
      const answer = await exchange(fetchFn, url.href, { headers: { Accept: 'application/rdap+json, application/json' } }, timeoutMs);
      if (answer.kind === 'failed') return answer.failure;
      if (answer.status === 404) return outcome({ kind: 'not_found' }, RDAP_NOT_FOUND_TTL_MS);
      if (answer.status !== 200) return httpFailure(answer.status);
      return parseRegistration(answer.body);
    })(domains, deadlineAt);
  }

  // ── Spamhaus DBL (DQS) ──
  // An A query for <domain>.<key>.dbl.dq.spamhaus.net through the system's resolver. A listing
  // is kept for its answer's TTL, "not listed" (NXDOMAIN or no A record) for the negative TTL of
  // the SOA in the answer, and not at all when the answer carries none.

  function dblVerdict({ rcode, addresses, negativeTtl }) {
    if (rcode === DNS_NXDOMAIN || (rcode === DNS_NOERROR && addresses.length === 0)) {
      return outcome(NOT_LISTED, negativeTtl === null ? null : negativeTtl * 1000);
    }
    if (rcode !== DNS_NOERROR) return failure('error', `DNS response code ${rcode}`);
    const codes = addresses.map(a => a.address);
    if (codes.includes(DBL_EXCESSIVE_QUERIES)) return failure('rate_limited', 'excessive number of queries');
    const listing = codes.find(code => {
      const last = Number(code.split('.')[3]);
      return code.startsWith('127.0.1.') && last >= 2 && last <= 199;
    });
    if (!listing) return failure('error', 'error return code from the service');
    return outcome(listed(DBL_LISTINGS[listing] ?? `listed with return code ${listing}`), Math.min(...addresses.map(a => a.ttl)) * 1000);
  }

  const dblLookup = key => eachLimited('spamhaus_dbl', async (domain, timeoutMs) => {
    const answer = await queryA(`${domain}.${key}.${endpoints.dblZone}`, {
      servers: endpoints.dnsServers ?? dns.getServers(),
      timeoutMs,
    });
    switch (answer.kind) {
      case 'answer': return dblVerdict(answer);
      case 'timeout': return DEADLINE_PASSED;
      case 'error': return failure('error', 'resolver unreachable or invalid DNS response');
      default: throw new Error(`unhandled DNS answer kind ${answer.kind}`);
    }
  });

  // ── URLhaus ──

  const urlhausLookup = key => eachLimited('urlhaus', async (domain, timeoutMs) => {
    const answer = await exchange(fetchFn, endpoints.urlhaus, {
      method: 'POST',
      headers: { 'Auth-Key': key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ host: domain }).toString(),
    }, timeoutMs);
    if (answer.kind === 'failed') return answer.failure;
    if (answer.status !== 200) return httpFailure(answer.status);
    const parsed = parseJson(answer.body);
    switch (isRecord(parsed) ? parsed.query_status : undefined) {
      case 'ok': {
        const count = Number(parsed.url_count);
        return outcome(listed(Number.isInteger(count) ? `${count} malware URLs seen on this host` : 'malware URLs seen on this host'), URLHAUS_TTL_MS);
      }
      case 'no_results':
        return outcome(NOT_LISTED, URLHAUS_TTL_MS);
      default:
        return failure('error', 'invalid response');
    }
  });

  // ── Safe Browsing ──
  // hashes.search with the 4-byte prefixes of every expression of a batch of URLs; the full hashes
  // that come back are matched here. The answer lives for the response's cacheDuration.

  async function safeBrowsingRequest(key, entries, timeoutMs) {
    const prefixes = [...new Set(entries.flatMap(e => e.hashes.map(h => h.subarray(0, 4).toString('base64'))))];
    const url = new URL(endpoints.safeBrowsing);
    for (const prefix of prefixes) url.searchParams.append('hashPrefixes', prefix);
    const every = result => new Map(entries.map(e => [e.canonical, result]));
    const answer = await exchange(fetchFn, url.href, { headers: { 'X-Goog-Api-Key': key, Accept: 'application/json' } }, timeoutMs);
    if (answer.kind === 'failed') return every(answer.failure);
    if (answer.status !== 200) return every(httpFailure(answer.status));
    const parsed = parseJson(answer.body);
    const ttlMs = isRecord(parsed) ? parseDuration(parsed.cacheDuration) : null;
    const fullHashes = isRecord(parsed) ? parsed.fullHashes ?? [] : null;
    if (ttlMs === null || !Array.isArray(fullHashes) || !fullHashes.every(h => isRecord(h) && typeof h.fullHash === 'string')) {
      return every(failure('error', 'invalid response'));
    }
    const threats = new Map(fullHashes.map(h => [h.fullHash, threatTypes(h)]));
    return new Map(entries.map(entry => {
      const types = new Set(entry.hashes.flatMap(h => [...(threats.get(h.toString('base64')) ?? [])]));
      return [entry.canonical, outcome(types.size ? listed([...types].sort().join(', ')) : NOT_LISTED, ttlMs)];
    }));
  }

  const safeBrowsingLookup = (key, expressionsOf) => async (canonicals, deadlineAt) => {
    // As many URLs per request as fit the API's limit of 1000 prefixes.
    const batches = [[]];
    let size = 0;
    for (const canonical of canonicals) {
      const hashes = expressionsOf.get(canonical).map(expressionHash);
      if (size + hashes.length > SAFE_BROWSING_MAX_PREFIXES) {
        batches.push([]);
        size = 0;
      }
      batches.at(-1).push({ canonical, hashes });
      size += hashes.length;
    }
    const limit = limiters.safe_browsing;
    const answers = await Promise.all(batches.map(async batch => {
      const answer = await limit(deadlineAt, timeoutMs => safeBrowsingRequest(key, batch, timeoutMs));
      return answer instanceof Map ? answer : new Map(batch.map(e => [e.canonical, answer]));
    }));
    return new Map(answers.flatMap(answer => [...answer]));
  };

  // ── Public API ──

  // deadlineMs is how long the whole lookup may take, from the call.
  function deadlineOf(options = {}) {
    const { deadlineMs } = options;
    if (deadlineMs === undefined) return Infinity;
    if (typeof deadlineMs !== 'number' || !(deadlineMs > 0)) throw new TypeError('deadlineMs must be a positive number');
    return Date.now() + deadlineMs;
  }

  async function lookupDomains(domains, options) {
    const deadlineAt = deadlineOf(options);
    if (!Array.isArray(domains)) throw new TypeError('domains must be an array');
    domains.forEach((domain, i) => {
      if (registrableDomain(domain) !== domain) throw new TypeError(`domains[${i}] is not a registrable domain`);
    });
    const subjects = [...new Set(domains)];
    const config = await getConfigFn();
    const everyDomain = result => new Map(subjects.map(domain => [domain, result]));
    const [registration, dbl, urlhaus] = subjects.length === 0 ? [] : await Promise.all([
      config.rdapEnabled ? cachedLookup('rdap', subjects, deadlineAt, rdapLookup) : everyDomain(unknown('disabled')),
      config.spamhausDqsKey
        ? cachedLookup('spamhaus_dbl', subjects, deadlineAt, dblLookup(config.spamhausDqsKey))
        : everyDomain(UNCONFIGURED),
      config.urlhausAuthKey
        ? cachedLookup('urlhaus', subjects, deadlineAt, urlhausLookup(config.urlhausAuthKey))
        : everyDomain(UNCONFIGURED),
    ]);
    return new Map(subjects.map(domain => [domain, {
      registration: registration.get(domain),
      listings: { spamhaus_dbl: dbl.get(domain), urlhaus: urlhaus.get(domain) },
    }]));
  }

  async function lookupUrls(urls, options) {
    const deadlineAt = deadlineOf(options);
    if (!Array.isArray(urls)) throw new TypeError('urls must be an array');
    const canonicalOf = new Map();
    const expressionsOf = new Map();
    urls.forEach((url, i) => {
      if (!hostOfUrl(url)) throw new TypeError(`urls[${i}] is not an http(s) URL`);
      const { canonical, expressions } = urlExpressions(url);
      canonicalOf.set(url, canonical);
      expressionsOf.set(canonical, expressions);
    });
    const config = await getConfigFn();
    if (!config.safeBrowsingApiKey || expressionsOf.size === 0) {
      return new Map([...canonicalOf.keys()].map(url => [url, { safe_browsing: UNCONFIGURED }]));
    }
    const verdicts = await cachedLookup('safe_browsing', [...expressionsOf.keys()], deadlineAt,
      safeBrowsingLookup(config.safeBrowsingApiKey, expressionsOf),
      row => row.result.kind !== 'listed' || now() - row.fetchedAt <= SAFE_BROWSING_LISTED_FRESH_MS);
    return new Map([...canonicalOf].map(([url, canonical]) => [url, { safe_browsing: verdicts.get(canonical) }]));
  }

  async function status() {
    const config = await getConfigFn();
    const keyed = key => (key ? 'enabled' : 'unconfigured');
    return {
      rdap: config.rdapEnabled ? 'enabled' : 'disabled',
      spamhaus_dbl: keyed(config.spamhausDqsKey),
      urlhaus: keyed(config.urlhausAuthKey),
      safe_browsing: keyed(config.safeBrowsingApiKey),
    };
  }

  return { lookupDomains, lookupUrls, status };
}

const reputation = createReputation();

export const lookupDomains = reputation.lookupDomains;
export const lookupUrls = reputation.lookupUrls;
export const status = reputation.status;
