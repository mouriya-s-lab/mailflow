import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/db.js', () => ({ query: vi.fn() }));
vi.mock('../../src/services/safeFetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('../service-config/index.js', () => ({ getReputationConfig: vi.fn() }));
import { reputationUrlSubject } from './index.js';
import { urlExpressions } from './safeBrowsing.js';

describe('reputation URL snapshot identity', () => {
  it('uses exactly the canonical K6 cache subject, not raw spelling, scheme, port or fragment', () => {
    const urls = ['https://EXAMPLE.COM:443/a/../private?q=1#secret', 'https://example.com/private?q=1', 'http://example.com:80/private?q=1#other'];
    const canonical = urlExpressions(urls[0]).canonical;
    const expected = createHash('sha256').update(canonical, 'latin1').digest('hex');
    for (const url of urls) {
      expect(urlExpressions(url).canonical).toBe(canonical);
      expect(reputationUrlSubject(url)).toEqual({ urlDigest: expected, host: 'example.com' });
    }
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    // Paths and queries are case-sensitive; these are distinct canonical subjects.
    expect(reputationUrlSubject('https://example.com/Private?q=1').urlDigest).not.toBe(expected);
    expect(reputationUrlSubject('https://example.com/private?q=2').urlDigest).not.toBe(expected);
  });

  it('rejects inputs that Safe Browsing cannot check', () => {
    for (const url of ['mailto:a@example.com', '/relative', 'not a URL', null]) expect(() => reputationUrlSubject(url)).toThrow(TypeError);
  });
});
