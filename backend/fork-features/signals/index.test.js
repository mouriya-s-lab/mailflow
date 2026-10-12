import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/db.js', () => ({ query: vi.fn() }));
vi.mock('../headers/index.js', () => ({ getMessageHeaders: vi.fn() }));

import { query } from '../../src/services/db.js';
import { getMessageHeaders } from '../headers/index.js';
import { extractSignals, resolveLanguage, messageBodyText, getMessageSignals, getAccountMessageSignals } from './index.js';

const stored = headers => ({ kind: 'stored', headers, source: 'ingest' });
const AUTH = 'mx.example.org; spf=fail smtp.mailfrom=cmbchina-secure.top; dkim=none; dmarc=fail header.from=cmbchina-secure.top';

const row = (overrides = {}) => ({
  id: 'm1',
  from_name: '招商银行',
  from_email: 'service@cmbchina-secure.top',
  sender_name: null,
  sender_email: null,
  reply_to: [{ name: '', email: 'refund-desk@gmail.com' }],
  to_addresses: [{ name: 'A', email: 'a@example.org' }, { name: '', email: 'b@example.org' }],
  cc_addresses: [{ name: '', email: 'c@example.org' }],
  subject: '【招商银行】您的账户存在异常交易，请立即验证',
  date: new Date('2026-10-09T19:12:00Z'),
  in_reply_to: '<prev@mailflow-test.invalid>',
  body_text: null,
  body_html: '<p>尊敬的客户，请点击下方链接完成身份验证。</p><p><a href="https://cmb-verify-login.xyz/auth?id=8812">https://www.cmbchina.com/verify</a></p>',
  attachments: [{ part: '2', filename: '验证工具.zip', type: 'application/zip', size: 120 }],
  list_unsubscribe: null,
  is_bulk: false,
  ...overrides,
});

const anchors = links => `<div>${links.map(([href, text]) => `<a href="${href}">${text}</a>`).join(' ')}</div>`;

describe('extractSignals', () => {
  it('builds the full signal set of a phishing message', () => {
    const signals = extractSignals({
      message: row(),
      headers: stored({ 'authentication-results': AUTH, 'list-id': 'Bank news <news.cmbchina-secure.top>' }),
      account: { trusted_authserv_id: 'mx.example.org' },
    });
    expect(signals).toEqual({
      sender: {
        from: { name: '招商银行', email: 'service@cmbchina-secure.top' },
        sender: null,
        replyTo: [{ name: null, email: 'refund-desk@gmail.com' }],
      },
      recipients: { to: 2, cc: 1 },
      subject: '【招商银行】您的账户存在异常交易，请立即验证',
      date: '2026-10-09T19:12:00.000Z',
      thread: { isReply: true },
      authentication: { kind: 'trusted', authservId: 'mx.example.org', spf: 'fail', dkim: 'none', dmarc: 'fail' },
      links: [{
        href: 'https://cmb-verify-login.xyz/auth?id=8812',
        hrefHost: 'cmb-verify-login.xyz',
        hrefDomain: 'cmb-verify-login.xyz',
        text: 'https://www.cmbchina.com/verify',
        textHost: 'www.cmbchina.com',
        textDomain: 'cmbchina.com',
        mismatch: true,
      }],
      attachments: [{ filename: '验证工具.zip', type: 'application/zip' }],
      mailingList: { listUnsubscribe: null, listId: 'Bank news <news.cmbchina-secure.top>', bulk: false },
      language: { resolved: 'zh', declared: { htmlLang: null, contentLanguage: null }, script: { dominant: 'Hani', letters: expect.any(Number) } },
    });
  });

  describe('authentication', () => {
    const auth = (headers, trusted) => extractSignals({ message: row(), headers, account: { trusted_authserv_id: trusted } }).authentication;

    it('is trusted, with the header results, when the account trusts the authserv-id', () => {
      expect(auth(stored({ 'authentication-results': AUTH }), 'MX.Example.org'))
        .toEqual({ kind: 'trusted', authservId: 'mx.example.org', spf: 'fail', dkim: 'none', dmarc: 'fail' });
    });

    it('is untrusted when the account trusts another id or none, judged at call time', () => {
      const headers = stored({ 'authentication-results': AUTH });
      expect(auth(headers, 'mx.other.test')).toEqual({ kind: 'untrusted', authservIds: ['mx.example.org'] });
      expect(auth(headers, null)).toEqual({ kind: 'untrusted', authservIds: ['mx.example.org'] });
    });

    it('honours only the trusted header among several', () => {
      const headers = stored({ 'authentication-results': `attacker.invalid; spf=pass; dkim=pass; dmarc=pass\n${AUTH}` });
      expect(auth(headers, 'mx.example.org'))
        .toEqual({ kind: 'trusted', authservId: 'mx.example.org', spf: 'fail', dkim: 'none', dmarc: 'fail' });
    });

    it('is absent when the stored headers carry no Authentication-Results', () => {
      expect(auth(stored({ from: 'x@example.org' }), 'mx.example.org')).toEqual({ kind: 'absent' });
    });

    it('reports headers that could not be read', () => {
      expect(auth({ kind: 'unavailable', reason: 'imap_error' }, 'mx.example.org'))
        .toEqual({ kind: 'headers_unavailable', reason: 'imap_error' });
    });
  });

  describe('links', () => {
    const links = html => extractSignals({ message: row({ body_html: html }), headers: stored({}), account: {} }).links;

    it('keeps only http(s) links, at most 50', () => {
      const html = anchors([
        ['javascript:alert(1)', 'run'],
        ['mailto:help@example.org', 'mail us'],
        ['/relative/path', 'relative'],
        ...Array.from({ length: 51 }, (_, i) => [`https://site${i}.example.com/p`, `link ${i}`]),
      ]);
      const result = links(html);
      expect(result).toHaveLength(50);
      expect(result[0].hrefHost).toBe('site0.example.com');
      expect(result.every(link => /^https:\/\//.test(link.href))).toBe(true);
    });

    it('has no text domain, and so no mismatch, for text that is not an address', () => {
      expect(links(anchors([['https://evil.example.net/x', '点击这里']]))[0])
        .toMatchObject({ hrefDomain: 'example.net', textHost: null, textDomain: null, mismatch: false });
    });

    it('compares registrable domains, not hosts', () => {
      expect(links(anchors([['https://login.bank.com.cn/a', 'www.bank.com.cn']]))[0])
        .toMatchObject({ hrefDomain: 'bank.com.cn', textDomain: 'bank.com.cn', mismatch: false });
      expect(links(anchors([['https://shop.com.cn/a', 'bank.com.cn']]))[0])
        .toMatchObject({ hrefDomain: 'shop.com.cn', textDomain: 'bank.com.cn', mismatch: true });
    });
  });

  it('reads language declarations from the HTML and the stored Content-Language', () => {
    const language = (html, headers) => extractSignals({ message: row({ subject: 'Hi', body_html: html }), headers, account: {} }).language;
    expect(language('<div lang="fr"><p>x</p></div>', stored({ 'content-language': 'de-DE, en' })).declared)
      .toEqual({ htmlLang: 'fr', contentLanguage: 'de-DE' });
    expect(language('<p>x</p>', stored({ 'content-language': 'not a tag!' })).declared)
      .toEqual({ htmlLang: null, contentLanguage: null });
  });
});

describe('resolveLanguage', () => {
  const resolve = input => resolveLanguage({ subject: '', bodyText: null, bodyHtml: null, contentLanguage: null, ...input });

  it('Chinese body with lang="en" is zh, keeping the declaration', () => {
    const result = resolve({ subject: '账单提醒', bodyHtml: '<html lang="en"><body><p>尊敬的客户，您的账户本月账单已经生成，请登录网上银行查看详情。</p></body></html>' });
    expect(result.resolved).toBe('zh');
    expect(result.declared.htmlLang).toBe('en');
  });

  it('Han-only text declared ja is ja', () => {
    expect(resolve({ subject: '会議', bodyHtml: '<p lang="ja">東京都新宿区会議室予約確認</p>' }).resolved).toBe('ja');
  });

  it('a short subject with kana is ja', () => {
    expect(resolve({ subject: 'お知らせ' }).resolved).toBe('ja');
  });

  it('English without a declaration is en', () => {
    expect(resolve({ bodyText: 'Thank you for your order. Your package will be shipped to you within two days and we will send you the tracking number.' }).resolved).toBe('en');
  });

  it('German declared en is de', () => {
    const result = resolve({ bodyHtml: '<html lang="en"><body><p>Ihre Bestellung ist bei uns eingegangen und wird in den nächsten Tagen an Sie versendet. Bitte prüfen Sie die Adresse.</p></body></html>' });
    expect(result.resolved).toBe('de');
    expect(result.declared.htmlLang).toBe('en');
  });

  it('15 Latin letters with no stop words and no declaration are und-Latn', () => {
    const result = resolve({ subject: 'Invoice', bodyText: 'Q3 Summary' });
    expect(result.script).toEqual({ dominant: 'Latn', letters: 15 });
    expect(result.resolved).toBe('und-Latn');
  });

  it('Arabic is ar', () => {
    expect(resolve({ bodyText: 'مرحبا بك في خدمتنا الجديدة' }).resolved).toBe('ar');
  });

  it('Latin text without stop-word evidence takes a declaration of the same script', () => {
    expect(resolve({ subject: 'Invoice', bodyText: 'Q3 Summary', contentLanguage: 'nl-NL' }).resolved).toBe('nl');
    expect(resolve({ subject: 'Invoice', bodyText: 'Q3 Summary', contentLanguage: 'ru' }).resolved).toBe('und-Latn');
  });

  it('text with no letters takes the declaration, or und', () => {
    expect(resolve({ bodyText: '12345 !!!', contentLanguage: 'pt-BR' }).resolved).toBe('pt');
    expect(resolve({ bodyText: '12345 !!!' }))
      .toEqual({ resolved: 'und', declared: { htmlLang: null, contentLanguage: null }, script: { dominant: null, letters: 0 } });
  });

  it('counts at most 4000 letters', () => {
    expect(resolve({ bodyText: 'a'.repeat(5000) }).script.letters).toBe(4000);
  });

  it('prefers the <html> lang over a descendant lang, and ignores script and style text', () => {
    const result = resolve({ bodyHtml: '<html lang="de"><head><style>.a{}</style></head><body><div lang="fr"><script>var a</script><p>x</p></div></body></html>' });
    expect(result.declared.htmlLang).toBe('de');
    expect(result.script.letters).toBe(1);
  });
});

describe('messageBodyText', () => {
  it('is body_text, or the visible text of body_html', () => {
    expect(messageBodyText({ bodyText: 'plain', bodyHtml: '<p>html</p>' })).toBe('plain');
    expect(messageBodyText({ bodyText: '', bodyHtml: '<p>Hello &amp; <b>bye</b></p><style>p{}</style>' })).toBe('Hello & bye');
  });
});

describe('getMessageSignals', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  beforeEach(() => {
    query.mockReset();
    getMessageHeaders.mockReset();
    getMessageHeaders.mockImplementation(async requested => new Map(requested.map(id => [id, { kind: 'unavailable', reason: 'imap_error' }])));
  });

  it('reads the headers of a batch across folders in one K4 call', async () => {
    query.mockResolvedValueOnce({ rows: ids.map((id, i) => ({ ...row({ id }), folder: i % 2 ? 'INBOX' : 'Archive', trusted_authserv_id: null })) });

    const signals = await getMessageSignals(ids, { deadlineMs: 5000 });

    expect(getMessageHeaders).toHaveBeenCalledTimes(1);
    expect(getMessageHeaders.mock.calls[0][0]).toEqual(ids);
    expect(getMessageHeaders.mock.calls[0][1]).toEqual({ deadlineMs: 5000 });
    expect(signals.size).toBe(50);
    expect(signals.get(ids[7]).authentication).toEqual({ kind: 'headers_unavailable', reason: 'imap_error' });
  });

  it('leaves out ids with no row and judges trust by each row\'s account', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...row({ id: ids[0] }), trusted_authserv_id: 'mx.example.org' }] });
    getMessageHeaders.mockResolvedValueOnce(new Map([[ids[0], stored({ 'authentication-results': AUTH })]]));

    const signals = await getMessageSignals([ids[0], ids[1]]);

    expect([...signals.keys()]).toEqual([ids[0]]);
    expect(signals.get(ids[0]).authentication.kind).toBe('trusted');
  });

  it('does not query for an empty batch', async () => {
    expect((await getMessageSignals([])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(getMessageHeaders).not.toHaveBeenCalled();
  });

  it('scopes the account form to the account', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const signals = await getAccountMessageSignals('acct-1', [ids[0]]);
    expect(signals.size).toBe(0);
    expect(query.mock.calls[0][0]).toMatch(/m\.account_id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['acct-1', [ids[0]]]);
    expect(getMessageHeaders).not.toHaveBeenCalled();
  });
});
