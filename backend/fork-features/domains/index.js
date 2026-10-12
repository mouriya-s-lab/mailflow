// Registrable domains from the Public Suffix List (tldts), private suffixes included: every
// user site under github.io or blogspot.com is its own registrable domain.

import { domainToASCII } from 'node:url';
import { parse } from 'tldts';

const PSL_OPTIONS = { allowPrivateDomains: true };

// `host` is lowercased, loses one trailing dot and is converted to punycode before the lookup.
// Returns null for an IP address, localhost, an invalid host, or a host that is itself a public
// suffix (com.cn, github.io).
export function registrableDomain(host) {
  if (typeof host !== 'string') return null;
  const trimmed = host.trim();
  const ascii = domainToASCII(trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed);
  if (!ascii) return null;
  // tldts reports no domain for an IP address or a host that fails its hostname validation.
  return parse(ascii, PSL_OPTIONS).domain;
}

// The host of an absolute http(s) URL; null for any other scheme, a relative reference or a
// string that does not parse.
export function hostOfUrl(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.endsWith('.') ? parsed.hostname.slice(0, -1) : parsed.hostname;
  return host || null;
}
