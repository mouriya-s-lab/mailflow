import { describe, expect, it } from 'vitest';
import {
  cleanText,
  tokenize,
  normalizeToken,
  extractFlagFeatures,
  tokenFingerprint,
  MAX_BODY_CHARS,
  MAX_TOKENS,
} from './spamTokenizer.js';

describe('cleanText', () => {
  it('strips HTML tags and collapses whitespace', () => {
    expect(cleanText('<p>Hello   <b>world</b></p>')).toBe('Hello world');
  });

  it('drops script/style/head content', () => {
    const html =
      '<html><head><style>p{color:red}</style></head>' +
      '<script>alert(1)</script><body>Visible body</body></html>';
    expect(cleanText(html)).toBe('Visible body');
  });

  it('decodes HTML entities on the plain path', () => {
    expect(cleanText('Tom &amp; Jerry &nbsp; --')).toBe('Tom & Jerry --');
  });

  it('returns empty for empty/whitespace input', () => {
    expect(cleanText('')).toBe('');
    expect(cleanText('   \n  ')).toBe('');
  });
});

describe('normalizeToken', () => {
  it('lowercases', () => {
    expect(normalizeToken('SPAM', 'en')).toBe('spam');
  });

  it('uses only the partition language stop words', () => {
    expect(normalizeToken('il', 'it')).toBeNull();
    expect(normalizeToken('il', 'en')).toBe('il');
    expect(normalizeToken('the', 'en')).toBeNull();
    expect(normalizeToken('the', 'und-Latn')).toBeNull();
    expect(normalizeToken('the', 'it')).toBe('the');
    expect(normalizeToken('the', 'pt')).toBe('the');
    expect(normalizeToken('и', 'ru')).toBeNull();
  });

  it('drops pure-numeric tokens', () => {
    expect(normalizeToken('12345', 'en')).toBeNull();
    expect(normalizeToken('2024', 'en')).toBeNull();
  });

  it('enforces min length 2 and max length 30', () => {
    expect(normalizeToken('a', 'en')).toBeNull();
    expect(normalizeToken('x'.repeat(31), 'en')).toBeNull();
    expect(normalizeToken('ab', 'en')).toBe('ab');
  });

  it('keeps spam-discriminative words', () => {
    expect(normalizeToken('viagra', 'en')).toBe('viagra');
    expect(normalizeToken('click', 'en')).toBe('click');
  });

  it('keeps whole Han words and single Han ideographs', () => {
    expect(normalizeToken('药店', 'zh')).toBe('药店');
    expect(normalizeToken('药', 'zh')).toBe('药');
    expect(tokenize({ subject: '药' }, 'zh')).toEqual(['药', '药']);
  });
});

describe('tokenize', () => {
  it('tokenizes subject + body, weighting subject by duplication', () => {
    const tokens = tokenize({
      subject: 'free money',
      body: 'click here for viagra',
    }, 'en');
    // subject appears twice (x2 weight), body once
    expect(tokens.filter(t => t === 'free').length).toBe(2);
    expect(tokens.filter(t => t === 'money').length).toBe(2);
    expect(tokens.filter(t => t === 'click').length).toBe(1);
    expect(tokens.filter(t => t === 'viagra').length).toBe(1);
  });

  it('returns empty when the subject is only emoji/stop-words', () => {
    expect(tokenize({ subject: '🎉🎉 the and of for', body: '' }, 'en').length).toBe(0);
  });

  it('strips HTML from the body', () => {
    const tokens = tokenize({ subject: 'sale', body: '<a href="#">buy now</a>' }, 'en');
    expect(tokens.filter(t => t === 'buy').length).toBe(1);
  });

  it('handles Cyrillic tokens', () => {
    const tokens = tokenize({ subject: 'виагра', body: '' }, 'en');
    expect(tokens).toContain('виагра');
  });

  it('extracts URL-host tokens separately', () => {
    const tokens = tokenize({ subject: 'offer', body: 'visit https://bit.ly/x now' }, 'en');
    expect(tokens).toContain('bit.ly');
  });

  it('when body is missing falls back to bodyHtml', () => {
    const tokens = tokenize({ subject: 'note', bodyHtml: '<p>urgent invoice</p>' }, 'en');
    expect(tokens).toContain('urgent');
    expect(tokens).toContain('invoice');
  });

  it('segments Chinese into whole words rather than first characters', () => {
    const tokens = tokenize({ body: '网上药店特价销售' }, 'zh');
    expect(tokens).toContain('药店');
    expect(tokens).not.toContain('药');
  });

  it('segments Japanese words and drops single kana', () => {
    const tokens = tokenize({ body: '無料クーポンを今すぐ受け取る あ' }, 'ja');
    expect(tokens).toContain('無料');
    expect(tokens).not.toContain('を');
    expect(tokens).not.toContain('あ');
  });

  it('keeps Korean Hangul words whole', () => {
    expect(tokenize({ body: '무료 쿠폰을 지금 받으세요' }, 'ko'))
      .toEqual(['무료', '쿠폰을', '지금', '받으세요']);
  });

  it('requires an explicit language', () => {
    expect(() => tokenize({ subject: 'hello' })).toThrow(TypeError);
  });
});

describe('tokenize — size caps', () => {
  it('truncates the raw body to MAX_BODY_CHARS before parsing', () => {
    // A marker beyond the cap must not contribute tokens.
    const body = `${'alpha '.repeat(12_000)} zzmarkerzz`; // ~72k chars, marker past 64k
    expect(body.length).toBeGreaterThan(MAX_BODY_CHARS);

    const tokens = tokenize({ subject: 'ok', body }, 'en');
    expect(tokens).toContain('alpha');
    expect(tokens).not.toContain('zzmarkerzz');
  });

  it('caps the token stream at MAX_TOKENS', () => {
    const body = Array.from({ length: MAX_TOKENS + 500 }, (_, i) => `w${i}`).join(' ');
    const tokens = tokenize({ subject: 'subject', body }, 'en');
    expect(tokens.length).toBe(MAX_TOKENS);
  });

  it('keeps the subject tokens when the body alone would exhaust the cap', () => {
    const body = Array.from({ length: MAX_TOKENS + 500 }, (_, i) => `w${i}`).join(' ');
    const tokens = tokenize({ subject: 'urgentpayment', body }, 'en');
    // Subject is pushed first (twice), so it survives the cap.
    expect(tokens.filter(t => t === 'urgentpayment').length).toBe(2);
  });

  it('does not leak skipped-tag content when the cap truncates HTML mid-tag', () => {
    // <script> opens well before the cap and is never closed (the cap cuts it),
    // so the whole tail must still be treated as script content and dropped.
    const html = `<p>hello</p><script>${'x'.repeat(MAX_BODY_CHARS * 2)}`;
    const tokens = tokenize({ subject: 'ok', bodyHtml: html }, 'en');
    expect(tokens).toContain('hello');
    expect(tokens.some(t => /^x+$/.test(t))).toBe(false);
  });

  it('caps an over-long subject too', () => {
    const subject = `${'y'.repeat(MAX_BODY_CHARS + 100)}`;
    const tokens = tokenize({ subject, body: '' }, 'en');
    expect(tokens.length).toBeLessThanOrEqual(MAX_TOKENS);
  });
});

describe('extractFlagFeatures', () => {
  it('computes auth flags with null when header absent', () => {
    const flags = extractFlagFeatures({ subject: 'hi', headers: [] });
    expect(flags.dkim_pass).toBeNull();
    expect(flags.spf_pass).toBeNull();
    expect(flags.dmarc_pass).toBeNull();
  });

  it('sets dkim_pass=1 on pass, 0 on fail', () => {
    const pass = extractFlagFeatures({
      subject: 'hi',
      headers: ['Authentication-Results: mx.com; dkim=pass header.d=x.com'],
    }, { trustedAuthservIds: 'mx.com' });
    expect(pass.dkim_pass).toBe(1);
    const fail = extractFlagFeatures({
      subject: 'hi',
      headers: ['Authentication-Results: mx.com; dkim=fail header.d=x.com'],
    }, { trustedAuthservIds: 'mx.com' });
    expect(fail.dkim_pass).toBe(0);
  });

  it('leaves the auth flags null when the header is not from a trusted authserv-id', () => {
    const flags = extractFlagFeatures({
      subject: 'hi',
      headers: ['Authentication-Results: attacker.invalid; dkim=pass; spf=pass; dmarc=pass'],
    }, { trustedAuthservIds: 'mx.example.com' });
    expect(flags.dkim_pass).toBeNull();
    expect(flags.spf_pass).toBeNull();
    expect(flags.dmarc_pass).toBeNull();

    // And with no trusted id configured at all (the default).
    const untrusted = extractFlagFeatures({
      subject: 'hi',
      headers: ['Authentication-Results: mx.example.com; dkim=pass'],
    });
    expect(untrusted.dkim_pass).toBeNull();
  });

  it('detects executable attachments', () => {
    const flags = extractFlagFeatures({
      subject: 'hi',
      attachments: [{ filename: 'invoice.pdf.exe' }],
    });
    expect(flags.has_attachment).toBe(1);
    expect(flags.attachment_is_executable).toBe(1);
  });

  it('ignores non-executable attachments', () => {
    const flags = extractFlagFeatures({
      subject: 'hi',
      attachments: [{ filename: 'invoice.pdf' }],
    });
    expect(flags.attachment_is_executable).toBe(0);
  });

  it('computes all_caps_subject_ratio', () => {
    expect(extractFlagFeatures({ subject: 'HELLO' }).all_caps_subject_ratio).toBe(1);
    expect(extractFlagFeatures({ subject: 'Hello' }).all_caps_subject_ratio).toBe(1 / 5);
    expect(extractFlagFeatures({ subject: '123' }).all_caps_subject_ratio).toBe(0);
  });

  it('detects from/reply-to domain mismatch', () => {
    const mismatch = extractFlagFeatures({
      subject: 'hi',
      from: 'sender@example.com',
      replyTo: 'other@spoof.net',
    });
    expect(mismatch.from_equals_reply_to_mismatch).toBe(1);
    const match = extractFlagFeatures({
      subject: 'hi',
      from: 'sender@example.com',
      replyTo: 'reply@example.com',
    });
    expect(match.from_equals_reply_to_mismatch).toBe(0);
  });
});

describe('tokenFingerprint', () => {
  it('is deterministic for identical messages', () => {
    const a = { subject: 'hi', body: 'world' };
    expect(tokenFingerprint(a, 'en')).toBe(tokenFingerprint({ ...a }, 'en'));
  });

  it('changes when the content changes', () => {
    expect(tokenFingerprint({ subject: 'hi', body: 'world' }, 'en')).not.toBe(
      tokenFingerprint({ subject: 'hi', body: 'different' }, 'en'),
    );
  });

  it('yields a 64-char hex digest', () => {
    expect(tokenFingerprint({ subject: 'hi' }, 'en')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('attachment_is_executable (#457)', () => {
  const flag = attachments => extractFlagFeatures({ subject: '', body: '', attachments }).attachment_is_executable;

  it('looks inside a forwarded .eml for a program', () => {
    const forward = contains => ({ filename: 'Fwd.eml', type: 'message/rfc822', contains });
    expect(flag([forward([{ filename: 'payload.exe', type: 'application/octet-stream' }])])).toBe(1);
    expect(flag([forward([{ filename: 'report.pdf', type: 'application/pdf' }])])).toBe(0);
    expect(extractFlagFeatures({ subject: '', body: '', attachments: [forward([{ filename: 'a.exe' }])] }).has_attachment).toBe(1);
  });

  it('means the BLOCK tier: files that run code when opened', () => {
    for (const filename of ['invoice.exe', 'run.ps1', 'shortcut.lnk', 'disk.iso', 'install.sh']) {
      expect(flag([{ filename }]), filename).toBe(1);
    }
    for (const filename of ['budget.xlsm', 'login.html', 'notes.rb', 'App.class', 'report.pdf']) {
      expect(flag([{ filename }]), filename).toBe(0);
    }
  });

  it('falls back to the stored MIME type when the part has no extension', () => {
    // walkStructure names an unnamed attachment "attachment" and stores its MIME type as `type`;
    // the fallback read `contentType`, which stored attachments never have.
    expect(flag([{ filename: 'attachment', type: 'application/x-msdownload' }])).toBe(1);
    expect(flag([{ filename: 'attachment', type: 'application/x-msdos-program' }])).toBe(1);
  });

  it('does not take ordinary Office files for programs', () => {
    expect(flag([{ filename: 'attachment', type: 'application/vnd.ms-excel' }])).toBe(0);
    expect(flag([{ filename: 'attachment', type: 'application/vnd.ms-powerpoint' }])).toBe(0);
    expect(flag([{ filename: 'attachment', type: 'application/pdf' }])).toBe(0);
  });
});
