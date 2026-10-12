// URL expressions for Google Safe Browsing, after "URLs and Hashing"
// (https://developers.google.com/safe-browsing/reference/URLs.and.Hashing): canonicalize the URL,
// then form up to 30 host-suffix/path-prefix expressions. Each is hashed with SHA-256, and only a
// 4-byte prefix of each hash is sent to Google.
//
// The steps work on byte strings, one char per byte, so an escaped UTF-8 byte stays one byte.

import { createHash } from 'node:crypto';
import { registrableDomain } from '../domains/index.js';

function unescapeFully(bytes) {
  let current = bytes;
  for (;;) {
    const next = current.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) return current;
    current = next;
  }
}

// Escapes every byte <= 32 or >= 127, '#' and '%', in uppercase hex.
function escapeBytes(bytes) {
  let out = '';
  for (const char of bytes) {
    const code = char.charCodeAt(0);
    out += code <= 32 || code >= 127 || char === '#' || char === '%'
      ? `%${code.toString(16).toUpperCase().padStart(2, '0')}`
      : char;
  }
  return out;
}

function ipv4FromHex(high, low) {
  const value = ((parseInt(high, 16) << 16) | parseInt(low, 16)) >>> 0;
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

// The URL parser already lowercases the host, converts an IDN to punycode, writes every IPv4
// spelling (octal, hex, fewer components) as four decimals and compresses IPv6. Left to do:
// IPv4-mapped and NAT64 addresses become IPv4, and dots are trimmed and collapsed.
function canonicalHost(hostname) {
  const embedded = /^\[(?:::ffff|64:ff9b:):([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(hostname);
  if (embedded) return ipv4FromHex(embedded[1], embedded[2]);
  return escapeBytes(unescapeFully(hostname).replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.').toLowerCase());
}

// Resolves "/./" and "/../", collapses runs of slashes, keeps a trailing slash.
function canonicalPath(pathname) {
  const raw = unescapeFully(pathname);
  const segments = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  const trailing = segments.length > 0 && /\/(\.{1,2})?$/.test(raw);
  return escapeBytes(`/${segments.join('/')}${trailing ? '/' : ''}`);
}

const isIpLiteral = host => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');

// `url` is an absolute http(s) URL. Returns `canonical` (host, path and query of the canonical URL,
// the form a cache entry is keyed by) and `expressions` (at most 30).
export function urlExpressions(url) {
  const parsed = new URL(url.replace(/[\t\r\n]/g, ''));
  const href = parsed.href.split('#', 1)[0];
  const queryAt = href.indexOf('?');
  const host = canonicalHost(parsed.hostname);
  const path = canonicalPath(parsed.pathname);
  const search = queryAt >= 0 ? `?${escapeBytes(unescapeFully(href.slice(queryAt + 1)))}` : '';

  // The exact host, then up to four suffixes starting from the registrable domain (eTLD+1 from
  // the Public Suffix List) and adding one leading label at a time.
  const hosts = [host];
  const domain = isIpLiteral(host) ? null : registrableDomain(host);
  if (domain && domain !== host) {
    const leading = host.slice(0, -domain.length - 1).split('.');
    for (let extra = 0; extra < Math.min(4, leading.length); extra++) {
      const suffix = [...leading.slice(leading.length - extra), domain].join('.');
      if (!hosts.includes(suffix)) hosts.push(suffix);
    }
  }
  // The exact path with and without the query, then up to four directory prefixes from "/".
  const paths = search ? [path + search, path] : [path];
  const directories = path.split('/').slice(1, -1);
  for (let depth = 0; depth <= Math.min(3, directories.length); depth++) {
    const prefix = `/${directories.slice(0, depth).map(d => `${d}/`).join('')}`;
    if (!paths.includes(prefix)) paths.push(prefix);
  }
  return { canonical: host + path + search, expressions: hosts.flatMap(h => paths.map(p => h + p)) };
}

export const expressionHash = expression => createHash('sha256').update(expression, 'latin1').digest();
