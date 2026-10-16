import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convert, WasmConversionOptions, WasmPreprocessingOptions, WasmPreprocessingPreset, WasmTierStrategy } from '@xberg-io/html-to-markdown-wasm';

vi.mock('../../src/services/db.js', () => ({ query: vi.fn() }));

import { query } from '../../src/services/db.js';
import { messageBodyMarkdown, getAccountMessageBodyMarkdowns } from './markdown.js';

const deepHtml = () => `<p>Visible prefix before truncation</p>${'<strong>'.repeat(1000)}Hidden deeply nested content${'</strong>'.repeat(1000)}`;

const structuredHtml = `<!doctype html><html><head>
  <style>.noise { color: red; } /* STYLE_NOISE */</style>
  <script>window.SCRIPT_NOISE = true;</script>
</head><body>
  <nav><a href="https://example.org/menu">NAVIGATION_NOISE</a></nav>
  <form><label>FORM_NOISE<input name="password"></label><button>SUBMIT_NOISE</button></form>
  <main>
    <h1>Monthly statement</h1>
    <p>Amount <strong>due</strong>: <a href="https://bank.example/pay">Pay invoice</a></p>
    <ul><li>First item</li><li>Second item</li></ul>
    <table><thead><tr><th>Item</th><th>Amount</th></tr></thead>
      <tbody><tr><td>Service</td><td>42</td></tr></tbody></table>
  </main>
</body></html>`;

describe('messageBodyMarkdown', () => {
  it('preserves headings, lists, tables and links while removing navigation, forms, scripts and styles', () => {
    const document = messageBodyMarkdown({ bodyHtml: structuredHtml, bodyText: null });

    expect(document).toMatch(/^# Monthly statement$/m);
    expect(document).toContain('**due**');
    expect(document).toContain('[Pay invoice](https://bank.example/pay)');
    expect(document).toMatch(/^[-*] First item$/m);
    expect(document).toMatch(/^[-*] Second item$/m);
    expect(document).toMatch(/\|\s*Item\s*\|\s*Amount\s*\|/);
    expect(document).toMatch(/\|\s*:?-+:?\s*\|\s*:?-+:?\s*\|/);
    expect(document).toMatch(/\|\s*Service\s*\|\s*42\s*\|/);
    for (const noise of ['NAVIGATION_NOISE', 'FORM_NOISE', 'SUBMIT_NOISE', 'SCRIPT_NOISE', 'STYLE_NOISE']) {
      expect(document).not.toContain(noise);
    }
    expect(document).not.toMatch(/<(?:h1|li|table|script|style|nav|form)\b/i);
  });

  it('prefers HTML over a divergent text alternative, even when cleanup leaves an empty document', () => {
    expect(messageBodyMarkdown({ bodyHtml: '<h2>Authoritative HTML</h2>', bodyText: 'STALE_TEXT_ALTERNATIVE' }))
      .toMatch(/^## Authoritative HTML$/m);
    expect(messageBodyMarkdown({ bodyHtml: '<nav>Only navigation</nav>', bodyText: 'STALE_TEXT_ALTERNATIVE' })).toBe('');
  });

  it.each([null, undefined, '', ' \n\t '])('leaves text-only mail unchanged when HTML is %j', bodyHtml => {
    const bodyText = '  Plain <literal> & text\r\n\n  - not HTML\n😀';
    expect(messageBodyMarkdown({ bodyText, bodyHtml })).toBe(bodyText);
  });

  it.each([
    { bodyText: '', bodyHtml: null },
    { bodyText: null, bodyHtml: null },
    {},
    { bodyText: null, bodyHtml: '<p></p>' },
  ])('accepts a genuinely empty body: %j', body => {
    expect(messageBodyMarkdown(body)).toBe('');
  });

  it('rejects excessive depth instead of accepting the converter\'s partial Markdown', () => {
    const bodyHtml = deepHtml();
    const options = WasmConversionOptions.default();
    const preprocessing = new WasmPreprocessingOptions(true, WasmPreprocessingPreset.Aggressive, true, true);
    options.preprocessing = preprocessing;
    preprocessing.free();
    options.tierStrategy = WasmTierStrategy.Tier2;
    const partial = convert(bodyHtml, options);
    const warnings = partial.warnings;
    try {
      expect(warnings.map(warning => warning.kind)).toContain('depth_limit_exceeded');
      expect(partial.content).toContain('Visible prefix before truncation');
      expect(partial.content).not.toContain('Hidden deeply nested content');
    } finally {
      for (const warning of warnings) warning.free();
      partial.free();
    }
    expect(() => messageBodyMarkdown({ bodyHtml, bodyText: 'Do not silently fall back' })).toThrow(/depth limit/i);
  });
});

describe('getAccountMessageBodyMarkdowns', () => {
  beforeEach(() => query.mockReset());

  it('isolates a real conversion failure and distinguishes ready empty documents from missing rows', async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: 'bad', body_html: deepHtml(), body_text: 'Do not silently fall back' },
      { id: 'html', body_html: '<h1>Account statement</h1>', body_text: 'STALE_TEXT_ALTERNATIVE' },
      { id: 'plain', body_html: null, body_text: 'Unchanged plain text\r\n' },
      { id: 'empty', body_html: null, body_text: null },
    ] });

    const bodies = await getAccountMessageBodyMarkdowns('account-1', ['bad', 'html', 'plain', 'empty', 'missing']);

    expect(bodies.size).toBe(4);
    expect(bodies.get('bad')).toEqual({ kind: 'failed', reason: 'conversion_failed' });
    expect(bodies.get('html')).toEqual({ kind: 'ready', document: expect.stringMatching(/^# Account statement$/m) });
    expect(bodies.get('plain')).toEqual({ kind: 'ready', document: 'Unchanged plain text\r\n' });
    expect(bodies.get('empty')).toEqual({ kind: 'ready', document: '' });
    expect(bodies.has('missing')).toBe(false);
  });

  it('does not query for an empty batch', async () => {
    expect(await getAccountMessageBodyMarkdowns('account-1', [])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it('propagates database failures rather than reporting them as per-message conversion failures', async () => {
    const error = new Error('database unavailable');
    query.mockRejectedValueOnce(error);
    await expect(getAccountMessageBodyMarkdowns('account-1', ['owned'])).rejects.toBe(error);
  });
});
