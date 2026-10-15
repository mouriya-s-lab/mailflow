// Render tests for the shared stored-results viewer. The real panel, API wrapper and React store
// are used; only fetch is controlled at the HTTP boundary.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? k + " " + JSON.stringify(o) : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: out.code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', {
  url: 'https://mail.example.invalid',
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const mediaQueries = new Set();
const matchesViewport = query => {
  const max = query.match(/\(max-width:\s*(\d+)px\)/);
  const min = query.match(/\(min-width:\s*(\d+)px\)/);
  return Boolean(max || min)
    && (!max || window.innerWidth <= Number(max[1]))
    && (!min || window.innerWidth >= Number(min[1]));
};
dom.window.matchMedia = query => {
  const listeners = new Set();
  const media = {
    media: query,
    get matches() { return matchesViewport(query); },
    addEventListener(type, listener) { if (type === 'change') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'change') listeners.delete(listener); },
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
  };
  mediaQueries.add({ media, listeners });
  return media;
};
globalThis.matchMedia = dom.window.matchMedia;
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const PluginResultsPanel = (await import('./PluginResultsPanel.jsx')).default;

const rootHost = document.getElementById('root');
let root;
let requests;
let fetchImpl;

globalThis.fetch = (...args) => fetchImpl(...args);

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const accountA = { id: 'aaaaaaaa-0000-4000-8000-000000000001', emailAddress: 'a@example.invalid' };
const accountB = { id: 'aaaaaaaa-0000-4000-8000-000000000002', emailAddress: 'b@example.invalid' };

const plugin = (over = {}) => ({
  kind: 'listing',
  id: 'tag-spamhaus',
  source: 'spamhaus_dbl',
  activated: true,
  configuration: 'enabled',
  ...over,
});

const row = (id, over = {}) => ({
  id,
  accountId: accountA.id,
  accountEmail: accountA.emailAddress,
  folder: 'INBOX',
  uid: 12,
  subject: `Subject ${id}`,
  fromName: 'Sender',
  fromEmail: 'sender@example.invalid',
  date: '2026-10-14T12:00:00.000Z',
  facets: ['all', 'checked'],
  observation: {
    kind: 'listing',
    revision: 4,
    source: 'spamhaus_dbl',
    checkedAt: '2026-10-14T12:00:00.000Z',
    subjects: [{
      kind: 'domain',
      domain: 'checked.example.invalid',
      verdict: { kind: 'not_listed' },
    }],
  },
  ...over,
});

const page = (over = {}) => ({
  observedAt: '2026-10-15T12:00:00.000Z',
  plugin: plugin(),
  accounts: [accountA, accountB],
  counts: [
    { facet: 'all', count: 2 },
    { facet: 'checked', count: 2 },
    { facet: 'unknown', count: 1 },
    { facet: 'listed', count: 1 },
  ],
  messages: [row('initial')],
  nextCursor: null,
  ...over,
});

const render = async (props = {}) => {
  await React.act(async () => {
    root.render(React.createElement(PluginResultsPanel, {
      pluginId: 'tag-spamhaus',
      pluginName: 'Spamhaus DBL',
      onClose: () => {},
      ...props,
    }));
  });
  await flush();
};

const flush = async () => {
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
};

const settle = async (times = 3) => {
  for (let i = 0; i < times; i++) await flush();
};

const resizeViewport = async width => {
  await React.act(async () => {
    const previous = [...mediaQueries].map(entry => ({ ...entry, matched: entry.media.matches }));
    window.innerWidth = width;
    for (const { media, listeners, matched } of previous) {
      if (media.matches === matched) continue;
      for (const listener of listeners) listener({ matches: media.matches, media: media.media });
    }
    window.dispatchEvent(new dom.window.Event('resize'));
  });
  await settle();
};

const click = async control => {
  assert.ok(control, 'expected an available result viewer action');
  assert.equal(control.disabled, false, 'the action is enabled');
  await React.act(async () => {
    control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await flush();
};

const findAccountSelect = () => rootHost.querySelector('[data-testid="plugin-results-account"]');

const choose = async (control, value) => {
  assert.ok(control, `expected a result viewer control for ${value}`);
  await React.act(async () => {
    control.value = value;
    control.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await flush();
};

const chooseFacet = facet => choose(rootHost.querySelector('[data-testid="plugin-results-facet"]'), facet);

beforeEach(() => {
  window.innerWidth = 1024;
  mediaQueries.clear();
  requests = [];
  fetchImpl = (url, init = {}) => {
    const parsed = new URL(String(url), 'https://mail.example.invalid');
    const pending = deferred();
    requests.push({ url: parsed, init, ...pending });
    return pending.promise;
  };
  root = createRoot(rootHost);
});

afterEach(async () => {
  await React.act(async () => root.unmount());
  root = null;
  rootHost.replaceChildren();
});

describe('PluginResultsPanel', () => {
  test('does not let late facet or account responses replace the newest selection, and a filter resets cursor', async () => {
    await render();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.searchParams.get('facet'), 'all');
    assert.equal(requests[0].url.searchParams.get('cursor'), null);

    // The first page supplies the live account choices and a cursor. Changing a filter must start
    // a fresh query rather than carrying this page position into another result set.
    requests[0].resolve(response(page({ nextCursor: 'cursor-from-all', messages: [row('all-old')] })));
    await settle();
    assert.match(rootHost.textContent, /Subject all-old/);
    await choose(findAccountSelect(), accountB.id);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url.searchParams.get('accountId'), accountB.id);
    assert.equal(requests[1].url.searchParams.get('facet'), 'all');
    assert.equal(requests[1].url.searchParams.get('cursor'), null, 'changing account starts at the first page');
    const pendingFacetOptions = rootHost.querySelector('[data-testid="plugin-results-facet"]').options;
    assert.equal(
      Array.from(pendingFacetOptions).some(option => /\(\d+\)/.test(option.textContent)),
      false,
      'a pending account scope must not present the previous account counts',
    );

    await chooseFacet('unknown');
    assert.equal(requests.length, 3);
    assert.equal(requests[2].url.searchParams.get('accountId'), accountB.id);
    assert.equal(requests[2].url.searchParams.get('facet'), 'unknown');
    assert.equal(requests[2].url.searchParams.get('cursor'), null, 'changing facet also starts at the first page');

    requests[2].resolve(response(page({ messages: [row('newest', {
      accountId: accountB.id,
      accountEmail: accountB.emailAddress,
      subject: 'Newest account and facet result',
      facets: ['unknown'],
    })] })));
    await settle();
    assert.match(rootHost.textContent, /Newest account and facet result/);

    // The older account response finishes after the newest facet scope. It must not put its
    // previous page back on screen.
    requests[1].resolve(response(page({ messages: [row('stale-account', { subject: 'Stale account result' })] })));
    await settle();
    assert.match(rootHost.textContent, /Newest account and facet result/);
    assert.doesNotMatch(rootHost.textContent, /Stale account result/);
  });

  test('keeps a visible error instead of turning a failed read into an empty result set', async () => {
    fetchImpl = async () => { throw new Error('database unavailable'); };
    await render();
    await settle();

    const alert = rootHost.querySelector('[role="alert"]');
    assert.ok(alert, 'the failed read has an alert for the user');
    assert.match(alert.textContent, /pluginResults\.loadFailed/);
    assert.doesNotMatch(rootHost.textContent, /pluginResults\.empty/);
    assert.doesNotMatch(rootHost.textContent, /pluginResults\.noResult/);
  });

  test('shows inactive saved mixed results without treating unknown as absent or safe', async () => {
    fetchImpl = async () => response(page({
      plugin: plugin({ activated: false, configuration: 'unconfigured' }),
      counts: [
        { facet: 'all', count: 1 },
        { facet: 'unknown', count: 1 },
        { facet: 'listed', count: 1 },
      ],
      messages: [row('inactive-mixed', {
        subject: 'Inactive mixed saved result',
        facets: ['all', 'unknown', 'listed'],
        observation: {
          kind: 'listing',
          revision: 7,
          source: 'spamhaus_dbl',
          checkedAt: '2026-10-14T12:00:00.000Z',
          subjects: [
            { kind: 'domain', domain: 'listed.example.invalid', verdict: { kind: 'listed', detail: 'malware' } },
            { kind: 'domain', domain: 'unknown.example.invalid', verdict: { kind: 'unknown', reason: 'source timeout' } },
          ],
        },
      })],
    }));
    await render();
    const detailsButton = rootHost.querySelector('[data-testid="plugin-results-row-details"]');
    assert.ok(detailsButton, 'the stored row exposes its result details control');
    await React.act(async () => {
      detailsButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await flush();

    assert.match(rootHost.textContent, /Inactive mixed saved result/);
    assert.match(rootHost.textContent, /pluginResults\.inactive/);
    assert.match(rootHost.textContent, /listed\.example\.invalid/);
    assert.match(rootHost.textContent, /unknown\.example\.invalid/);
    assert.match(rootHost.textContent, /pluginResults\.facets\.listed/);
    assert.match(rootHost.textContent, /pluginResults\.facets\.unknown/);
  });

  test('mobile cards retain every result field and expanded observations across breakpoints without resetting filters or cursors', async () => {
    await resizeViewport(767);
    await render();
    requests[0].resolve(response(page()));
    await settle();

    await choose(findAccountSelect(), accountB.id);
    requests[1].resolve(response(page({ messages: [row('account-scope')] })));
    await settle();
    await chooseFacet('unknown');
    requests[2].resolve(response(page({
      messages: [row('first-filtered-page')],
      nextCursor: 'filtered-page-two',
    })));
    await settle();
    await click(rootHost.querySelector('[data-testid="plugin-results-next"]'));
    assert.equal(requests.length, 4);
    assert.equal(requests[3].url.searchParams.get('accountId'), accountB.id);
    assert.equal(requests[3].url.searchParams.get('facet'), 'unknown');
    assert.equal(requests[3].url.searchParams.get('cursor'), 'filtered-page-two');

    const message = row('mobile-complete', {
      accountId: accountB.id,
      accountEmail: accountB.emailAddress,
      folder: 'Archive/Complete stored result folder',
      subject: 'Complete mobile stored result subject without truncating important context',
      fromName: 'Complete Sender Name',
      fromEmail: 'complete-sender@example.invalid',
      facets: ['all', 'listed', 'unknown'],
      observation: {
        kind: 'listing',
        revision: 9,
        source: 'spamhaus_dbl',
        checkedAt: '2026-10-13T11:00:00.000Z',
        subjects: [
          { kind: 'domain', domain: 'listed-mobile.example.invalid', verdict: { kind: 'listed', detail: 'Complete stored malware classification' } },
          { kind: 'domain', domain: 'unknown-mobile.example.invalid', verdict: { kind: 'unknown', reason: 'Complete stored upstream timeout explanation' } },
          { kind: 'domain', domain: 'safe-mobile.example.invalid', verdict: { kind: 'not_listed' } },
        ],
      },
    });
    requests[3].resolve(response(page({ messages: [message], nextCursor: 'filtered-page-three' })));
    await settle();

    const resultRow = () => {
      const rows = rootHost.querySelectorAll('[data-testid="plugin-results-row"]');
      assert.equal(rows.length, 1, 'the result appears once, not as duplicated mobile and desktop copies');
      return rows[0];
    };
    const assertFields = () => {
      const card = resultRow();
      for (const value of [
        message.accountEmail,
        message.folder,
        message.subject,
        `${message.fromName} <${message.fromEmail}>`,
        new Date(message.date).toLocaleString(),
        ...message.facets.map(facet => `pluginResults.facets.${facet}`),
      ]) {
        assert.ok(card.textContent.includes(value), `the result retains the complete field: ${value}`);
      }
      const open = card.querySelector('[data-testid="plugin-results-row-open"]');
      assert.ok(open, 'opening the original message remains available');
      assert.equal(open.disabled, false);
      assert.equal(open.textContent, 'pluginResults.open');
      assert.equal(card.querySelectorAll('[data-testid="plugin-results-row-details"]').length, 1);
    };
    assert.ok(resultRow().closest('table') === null, 'a narrow viewport presents a card rather than a seven-column table');
    assertFields();
    assert.equal(rootHost.querySelector('[data-testid="plugin-results-row-expanded"]'), null);
    await click(resultRow().querySelector('[data-testid="plugin-results-row-details"]'));

    const assertExpandedScope = () => {
      assertFields();
      const details = resultRow().querySelector('[data-testid="plugin-results-row-details"]');
      assert.equal(details.getAttribute('aria-expanded'), 'true');
      assert.equal(details.textContent, 'pluginResults.hideDetails');
      const expanded = rootHost.querySelectorAll('[data-testid="plugin-results-row-expanded"]');
      assert.equal(expanded.length, 1, 'the complete observation is still expanded exactly once');
      for (const value of [
        'pluginResults.revision {"revision":9}',
        'Spamhaus DBL',
        new Date(message.observation.checkedAt).toLocaleString(),
        'listed-mobile.example.invalid',
        'Complete stored malware classification',
        'unknown-mobile.example.invalid',
        'Complete stored upstream timeout explanation',
        'safe-mobile.example.invalid',
        'pluginResults.verdicts.listed',
        'pluginResults.verdicts.unknown',
        'pluginResults.verdicts.not_listed',
      ]) {
        assert.ok(expanded[0].textContent.includes(value), `the expanded observation retains: ${value}`);
      }
      assert.equal(findAccountSelect().value, accountB.id);
      assert.equal(rootHost.querySelector('[data-testid="plugin-results-facet"]').value, 'unknown');
      assert.equal(rootHost.querySelector('[data-testid="plugin-results-count-unknown"]').getAttribute('aria-pressed'), 'true');
      assert.equal(rootHost.querySelector('[data-testid="plugin-results-previous"]').disabled, false);
      assert.equal(requests.length, 4, 'expanding or resizing does not refetch stored results');
    };
    assertExpandedScope();
    await resizeViewport(768);
    assert.ok(resultRow().closest('table'), 'the desktop breakpoint restores the existing table view');
    assertExpandedScope();
    await resizeViewport(767);
    assert.ok(resultRow().closest('table') === null, 'returning to a narrow viewport restores the complete card');
    assertExpandedScope();

    await click(rootHost.querySelector('[data-testid="plugin-results-next"]'));
    assert.equal(requests.length, 5);
    assert.equal(requests[4].url.searchParams.get('accountId'), accountB.id);
    assert.equal(requests[4].url.searchParams.get('facet'), 'unknown');
    assert.equal(requests[4].url.searchParams.get('cursor'), 'filtered-page-three');
    requests[4].resolve(response(page({ messages: [row('third-filtered-page')] })));
    await settle();
    await click(rootHost.querySelector('[data-testid="plugin-results-previous"]'));
    assert.equal(requests.length, 6);
    assert.equal(requests[5].url.searchParams.get('accountId'), accountB.id);
    assert.equal(requests[5].url.searchParams.get('facet'), 'unknown');
    assert.equal(requests[5].url.searchParams.get('cursor'), 'filtered-page-two', 'resizing preserves the existing cursor history');
    requests[5].resolve(response(page({ messages: [message], nextCursor: 'filtered-page-three' })));
    await settle();
    assertFields();
  });
});
