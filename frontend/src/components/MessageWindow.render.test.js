// Exercise the real detached-window stack. Grouped rows deliberately have the same UUID
// as a physical message but different metadata; only the exact GET may supply a window.
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = code => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = globalThis.ResizeObserver;
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const FIRST = {
  id: '11111111-1111-4111-8111-111111111111', account_id: 'acct', folder: 'INBOX', uid: 11,
  thread_id: 'shared-thread', subject: 'Physical first subject',
  from_name: 'First Physical Sender', from_email: 'first@physical.example',
  date: '2026-03-04T09:30:00.000Z', is_read: true, to_addresses: [], cc_addresses: [],
};
const SECOND = {
  ...FIRST, id: '22222222-2222-4222-8222-222222222222', uid: 12,
  subject: 'Physical second subject', from_name: 'Second Physical Sender', from_email: 'second@physical.example',
};
const MISSING = { ...FIRST, id: '33333333-3333-4333-8333-333333333333', uid: 13 };
const GROUPED = {
  ...FIRST, subject: 'WRONG grouped sibling subject',
  from_name: 'WRONG Grouped Sibling', from_email: 'sibling@grouped.example',
};
const BODIES = new Map([
  [FIRST.id, { html: '<p>First exact physical body</p>', text: 'First exact physical body', attachments: [] }],
  [SECOND.id, { html: '<p>Second exact physical body</p>', text: 'Second exact physical body', attachments: [] }],
]);
const metadataPath = id => `/api/mail/messages/${id}`;
const bodyPath = id => `${metadataPath(id)}/body`;
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const routes = new Map();
const requests = [];
const unexpectedRequests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const path = String(url);
  requests.push({ path, method: options?.method });
  const route = routes.get(path);
  if (!route) {
    unexpectedRequests.push(path);
    throw new Error(`Unexpected request: ${path}`);
  }
  return route();
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const WindowLayer = (await import('./WindowLayer.jsx')).default;
let root;

beforeEach(async () => {
  routes.clear();
  requests.length = 0;
  unexpectedRequests.length = 0;
  routes.set('/api/ai/status', () => response({ configured: false }));
  for (const message of [FIRST, SECOND]) {
    routes.set(metadataPath(message.id), () => response(message));
    routes.set(bodyPath(message.id), () => response(BODIES.get(message.id)));
    routes.set(`/api/jev-classify/results/${message.id}`, () => response({
      observedAt: '2026-03-04T09:30:00.000Z',
      plugin: { id: 'jev-classify', kind: 'jev_spam', activated: false, configuration: 'unconfigured' },
      message: { id: message.id, observation: { kind: 'none', revision: null } },
    }));
  }
  routes.set(metadataPath(MISSING.id), () => response({ error: 'Physical message no longer exists' }, 404));
  useStore.getState().setUser({ id: 'window-render-user' });
  useStore.getState().setLocked(false);
  useStore.getState().setAccounts([{ id: 'acct', enabled: true, email_address: 'me@example.test', color: '#123456' }]);
  useStore.getState().setMessages([GROUPED]);
  useStore.getState().setSearchQuery('');
  useStore.getState().setSearchResults([]);
  for (const key of Object.keys(useStore.getState().threadMessages)) useStore.getState().clearThreadMessages(key);
  useStore.getState().setSelectedMessage(null);
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(WindowLayer)); });
});

afterEach(async () => {
  await React.act(async () => {
    root.unmount();
    for (const win of useStore.getState().messageWindows) useStore.getState().closeMessageWindow(win.winId);
  });
  assert.deepEqual(unexpectedRequests, [], 'all requests must use an explicitly mapped API endpoint');
});
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });

const frames = () => [...document.querySelectorAll('.mailflow-window')];
const title = frame => frame.querySelector('.mailflow-window-titlebar > div')?.textContent;
const frameFor = subject => {
  const frame = frames().find(element => title(element) === subject);
  assert.ok(frame, `a window is titled ${subject}`);
  return frame;
};
const bodyHtml = frame => frame.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const click = element => React.act(async () => {
  assert.ok(element, 'the requested window control exists');
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
async function open(messageId) {
  let result;
  await React.act(async () => { result = await useStore.getState().openMessageWindow(messageId); });
  await settle();
  return result;
}
function assertPhysical(frame, message, bodyText) {
  assert.equal(title(frame), message.subject, 'outer window title is physical');
  const card = frame.querySelector('.msg-card');
  assert.ok(card, 'the actual message pane is rendered');
  assert.ok([...card.querySelectorAll('span')].some(span => span.textContent === message.subject), 'inner pane subject is physical');
  assert.ok(card.textContent.includes(message.from_name), 'sender name is physical');
  assert.ok(card.textContent.includes(message.from_email), 'sender address is physical');
  assert.ok(bodyHtml(frame).includes(bodyText), 'body belongs to the same physical UUID');
  assert.ok(!frame.textContent.includes(GROUPED.subject), 'grouped subject is absent');
  assert.ok(!frame.textContent.includes(GROUPED.from_name), 'grouped sender is absent');
  assert.ok(!frame.textContent.includes(GROUPED.from_email), 'grouped sender address is absent');
}

test('a grouped representative opens with loading chrome, then exact physical metadata and body', async () => {
  let resolveMetadata;
  const metadata = new Promise(resolve => { resolveMetadata = resolve; });
  routes.set(metadataPath(FIRST.id), () => metadata);
  let opening;
  await React.act(async () => { opening = useStore.getState().openMessageWindow(FIRST.id); });
  assert.equal(frames().length, 1);
  assert.equal(title(frames()[0]), 'common.loading');
  assert.equal(frames()[0].querySelector('.msg-card'), null, 'no grouped pane is shown while physical metadata loads');
  assert.ok(!document.getElementById('root').textContent.includes(GROUPED.subject));
  assert.ok(!requests.some(request => request.path === bodyPath(FIRST.id)), 'body waits for exact metadata');

  let loaded;
  await React.act(async () => { resolveMetadata(response(FIRST)); loaded = await opening; });
  await settle();
  assert.equal(loaded?.id, FIRST.id);
  assertPhysical(frameFor(FIRST.subject), FIRST, 'First exact physical body');
  assert.deepEqual(requests.filter(request => request.path === metadataPath(FIRST.id)), [
    { path: metadataPath(FIRST.id), method: 'GET' },
  ]);
  assert.ok(requests.some(request => request.path === bodyPath(FIRST.id) && request.method === 'GET'));
});

test('distinct physical windows and the native minimize dock survive grouped list, search, and thread refresh', async () => {
  await open(FIRST.id);
  await open(SECOND.id);
  assert.equal(frames().length, 2);
  assertPhysical(frameFor(FIRST.subject), FIRST, 'First exact physical body');
  assertPhysical(frameFor(SECOND.subject), SECOND, 'Second exact physical body');
  assert.ok(!bodyHtml(frameFor(FIRST.subject)).includes('Second exact physical body'));
  assert.ok(!bodyHtml(frameFor(SECOND.subject)).includes('First exact physical body'));
  for (const message of [FIRST, SECOND]) {
    assert.equal(requests.filter(request => request.path === metadataPath(message.id)).length, 1);
    assert.ok(requests.some(request => request.path === bodyPath(message.id)));
  }

  await click(frameFor(FIRST.subject).querySelector('button[aria-label="window.minimize"]'));
  assert.equal(frames().length, 1);
  const dock = () => document.querySelector('.mailflow-window-min');
  assert.equal(dock()?.getAttribute('title'), FIRST.subject);
  assert.ok(dock().textContent.includes(FIRST.subject));

  const refreshed = { ...GROUPED, subject: 'WRONG refreshed conversation title', from_name: 'WRONG Refreshed Sender' };
  await React.act(async () => {
    const store = useStore.getState();
    store.setMessages([refreshed, { ...refreshed, id: SECOND.id }]);
    store.setSearchResults([{ ...refreshed }, { ...refreshed, id: SECOND.id }]);
    store.setSearchQuery('refreshed');
    store.setThreadMessages(FIRST.thread_id, [refreshed, { ...refreshed, id: SECOND.id }]);
    store.setThreadMessages(`__dl_${FIRST.id}`, [refreshed]);
    store.setThreadMessages(`__dl_${SECOND.id}`, [{ ...refreshed, id: SECOND.id }]);
  });
  assert.equal(dock()?.getAttribute('title'), FIRST.subject, 'minimized title is not replaced by grouped refresh');
  assertPhysical(frameFor(SECOND.subject), SECOND, 'Second exact physical body');
  assert.ok(!document.getElementById('root').textContent.includes(refreshed.subject));
  assert.ok(!document.getElementById('root').textContent.includes(refreshed.from_name));

  await click(dock());
  await settle();
  assert.equal(frames().length, 2);
  assert.equal(dock(), null);
  assertPhysical(frameFor(FIRST.subject), FIRST, 'First exact physical body');
  assertPhysical(frameFor(SECOND.subject), SECOND, 'Second exact physical body');
  assert.equal(requests.filter(request => request.path === metadataPath(FIRST.id)).length, 1, 'restore retains exact metadata without another GET');
});

test('a missing physical message shows an error instead of any grouped sibling or body', async () => {
  await React.act(async () => {
    useStore.getState().setMessages([{ ...GROUPED, id: MISSING.id }]);
    useStore.getState().setThreadMessages(`__dl_${MISSING.id}`, [{ ...GROUPED, id: MISSING.id }]);
  });
  const loaded = await open(MISSING.id);
  assert.equal(loaded, null);
  assert.equal(frames().length, 1);
  const frame = frames()[0];
  assert.equal(title(frame), 'message.loadingError');
  assert.ok(frame.querySelector('[role="alert"]')?.textContent.includes('Physical message no longer exists'));
  assert.equal(frame.querySelector('.msg-card'), null, 'failed metadata never mounts a sibling pane');
  assert.equal(frame.querySelector('iframe'), null);
  assert.ok(!frame.textContent.includes(GROUPED.subject));
  assert.ok(!frame.textContent.includes(GROUPED.from_name));
  assert.deepEqual(requests.filter(request => request.path.startsWith(metadataPath(MISSING.id))), [
    { path: metadataPath(MISSING.id), method: 'GET' },
  ], 'a metadata 404 must not start a body request');
  await click(frame.querySelector('button[aria-label="window.minimize"]'));
  assert.equal(document.querySelector('.mailflow-window-min')?.getAttribute('title'), 'message.loadingError');
});
