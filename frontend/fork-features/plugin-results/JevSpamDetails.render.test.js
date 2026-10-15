// Render tests for the stored Jev result detail. These use the real component and the real
// getStoredResult() request; only fetch, the browser boundary, is controlled.
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
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const JevSpamDetails = (await import('./JevSpamDetails.jsx')).default;

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

const plugin = (over = {}) => ({
  kind: 'jev_spam',
  id: 'jev-classify',
  activated: true,
  configuration: 'enabled',
  hamAtMost: 0.1,
  spamAtLeast: 0.9,
  ...over,
});

const message = (id, observation, over = {}) => ({
  id,
  accountId: 'account-a',
  accountEmail: 'a@example.invalid',
  folder: 'INBOX',
  uid: 12,
  subject: `Subject ${id}`,
  fromName: 'Sender',
  fromEmail: 'sender@example.invalid',
  date: '2026-10-14T12:00:00.000Z',
  facets: ['all'],
  observation,
  ...over,
});

const detail = (id, observation, over = {}) => ({
  observedAt: '2026-10-15T12:00:00.000Z',
  plugin: plugin(),
  message: message(id, observation, over),
});

const render = async (id) => {
  await React.act(async () => { root.render(React.createElement(JevSpamDetails, { messageId: id })); });
  await flush();
};

const flush = async () => {
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
};

const settle = async (times = 3) => {
  for (let i = 0; i < times; i++) await flush();
};

beforeEach(() => {
  requests = [];
  fetchImpl = (url, init = {}) => {
    const u = new URL(String(url), 'https://mail.example.invalid');
    const pending = deferred();
    requests.push({ url: u, init, ...pending });
    return pending.promise;
  };
  root = createRoot(rootHost);
});

afterEach(async () => {
  await React.act(async () => root.unmount());
  root = null;
  rootHost.replaceChildren();
});

describe('Jev stored result detail', () => {
  test('renders a stored none observation as no result, never as ham', async () => {
    fetchImpl = async () => response(detail('none-row', { kind: 'none', revision: 4 }));
    await render('none-row');
    await settle();

    assert.match(rootHost.textContent, /pluginResults\.noResult/, 'none is explicitly described as no result');
    assert.doesNotMatch(rootHost.textContent, /pluginResults\.(?:ham|outcomeHam)|pluginResults\.facets\.ham|\bham\b/i, 'none is not presented as ham');
    assert.doesNotMatch(rootHost.textContent, /0\.05|model-ham/, 'none does not invent a decision');
  });

  test('a late response for the previous message cannot replace the current detail', async () => {
    await render('message-a');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.pathname, '/api/jev-classify/results/message-a');

    await React.act(async () => {
      root.render(React.createElement(JevSpamDetails, { messageId: 'message-b' }));
    });
    await flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url.pathname, '/api/jev-classify/results/message-b');

    requests[1].resolve(response(detail('message-b', {
      kind: 'jev_spam',
      revision: 9,
      decision: {
        kind: 'done', outcome: 'ham', probability: 0.04,
        model: 'model-for-b', decidedAt: '2026-10-15T12:00:02.000Z',
      },
      training: { kind: 'below_threshold' },
    })));
    await settle();
    assert.match(rootHost.textContent, /model-for-b/);
    assert.match(rootHost.textContent, /0\.04/);

    requests[0].resolve(response(detail('message-a', {
      kind: 'jev_spam',
      revision: 8,
      decision: {
        kind: 'done', outcome: 'spam', probability: 0.97,
        model: 'stale-model-a', decidedAt: '2026-10-15T12:00:01.000Z',
      },
      training: { kind: 'recorded', label: 'spam' },
    })));
    await settle();

    assert.match(rootHost.textContent, /model-for-b/, 'the current message remains visible');
    assert.doesNotMatch(rootHost.textContent, /stale-model-a|0\.97/, 'the old message cannot overwrite it');
  });
});
