import { describe, expect, it } from 'vitest';
import { registrableDomain, hostOfUrl } from './index.js';

describe('registrableDomain', () => {
  it.each([
    ['mail.shop.com.cn', 'shop.com.cn'],
    ['a.b.co.uk', 'b.co.uk'],
    ['evil.github.io', 'evil.github.io'],
    ['EXAMPLE.com.', 'example.com'],
    ['例子.中国', 'xn--fsqu00a.xn--fiqs8s'],
    ['news.mail.example.com', 'example.com'],
  ])('%s -> %s', (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  it.each([
    'com.cn', 'co.uk', 'github.io', '127.0.0.1', '[::1]', 'localhost', 'not a host',
    '', '-a.example', 'a..example', 'user@example.com', 'example.com:443', null, undefined,
  ])('%s -> null', host => {
    expect(registrableDomain(host)).toBeNull();
  });
});

describe('hostOfUrl', () => {
  it.each([
    ['https://Mail.Shop.com.cn/login?x=1', 'mail.shop.com.cn'],
    ['http://example.com.:8080/', 'example.com'],
    ['https://例子.中国/', 'xn--fsqu00a.xn--fiqs8s'],
  ])('%s -> %s', (url, expected) => {
    expect(hostOfUrl(url)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)', 'mailto:a@example.com', 'ftp://example.com/', '/relative/path',
    'relative/path', '//example.com/x', 'not a url', '', null,
  ])('%s -> null', url => {
    expect(hostOfUrl(url)).toBeNull();
  });
});
