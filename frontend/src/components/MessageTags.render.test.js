import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import process from 'node:process';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) return {
    format: 'module', shortCircuit: true, source: `export const useTranslation = () => ({ t: (key, values) => key + (values && typeof values === 'object' ? ' ' + JSON.stringify(values) : ''), i18n: { language: 'en', changeLanguage() {} } }); export const initReactI18next = { type: '3rdParty', init() {} }; export const Trans = ({children}) => children;`,
  };
  if (url.endsWith('/src/utils/pdfDocument.js')) return { format: 'module', shortCircuit: true, source: 'export const openPdf = () => {}; export const renderPage = () => {}; export const renderPagesForPrint = async () => [];' };
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  if (url.startsWith('file:') && /\.(jsx|js)$/.test(url)) {
    let code = readFileSync(new URL(url), 'utf8');
    if (url.endsWith('.jsx')) code = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code;
    if (url.endsWith('.jsx') || code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  return nextLoad(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, __VITE_ENV__: { MODE: 'test', DEV: false, PROD: true, VITE_EMAIL_DIV_RENDER: process.env.VITE_EMAIL_DIV_RENDER },
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessageList = (await import('./MessageList.jsx')).default;
const MessagePane = (await import('./MessagePane.jsx')).default;
const ConversationMessageCard = (await import('./ConversationMessageCard.jsx')).default;
const MessageTags = (await import('./MessageTags.jsx')).default;
const Observer = (await import('./MessageTagObserver.js')).default;
const MSG = { id: 'aaaaaaaa-0000-4000-8000-000000000001', account_id: 'acct', folder: 'INBOX', uid: 1, subject: 'Tag fixture', snippet: '', message_id: '<tag@fixture.invalid>', from_name: 'Fixture', from_email: 'fixture@example.invalid', date: '2026-10-13T00:00:00Z', is_read: true, to_addresses: [], cc_addresses: [] };
const SUMMARY = {
  notable: [{ kind: 'listed', source: 'spamhaus_dbl' }, { kind: 'new_domain', domain: 'new.example', ageDays: 3 }, { kind: 'unknown', source: 'urlhaus' }],
  sources: { rdap: { kind: 'complete', checkedAt: '2026-10-13T00:00:00Z', subjects: 2, listed: 0, unknown: 1 }, spamhaus_dbl: { kind: 'inactive' }, urlhaus: { kind: 'unconfigured' }, safe_browsing: { kind: 'unavailable', reason: 'plugin_failed' } },
};
let root, requests, rows, resolvePending, pending;
const json = value => ({ ok: true, status: 200, json: async () => value, text: async () => '' });
function setup({ enabled = true, loaded = true, conversationMode = 'off' } = {}) {
  requests = []; rows = [MSG]; pending = false; resolvePending = null;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/message-tags/summary') {
      const body = JSON.parse(options.body);
      requests.push({ ...body, headers: options.headers });
      if (pending) await new Promise(resolve => { resolvePending = resolve; });
      return json({ tags: Object.fromEntries(body.ids.map(id => [id, SUMMARY])) });
    }
    if (String(url).includes('/mail/messages?')) return json({ messages: rows, total: rows.length });
    if (String(url).includes('/mail/thread?')) return json({ messages: rows });
    return json({});
  };
  useStore.setState({
    user: { id: 'user-fixture' }, accounts: [{ id: 'acct', enabled: true, email_address: 'fixture@example.invalid', include_in_unified_inbox: true }], accountsReady: true,
    selectedAccountId: 'acct', selectedFolder: 'INBOX', messages: rows, searchQuery: '', searchResults: [], selectedMessageId: null,
    messagesTotal: rows.length, hasMoreMessages: false, loadingMessages: false, threadMessages: {}, expandedThreads: new Set(),
    conversationMode, threadedView: conversationMode !== 'off', folders: { acct: [{ path: 'INBOX', name: 'INBOX' }] },
    showMessageTags: enabled, messageTagsPreferencesLoaded: loaded, visibleMessageTagIds: {}, messageTagLookup: { kind: 'ready', tags: {} },
  });
  root = createRoot(document.getElementById('root'));
}
const mount = async component => { await React.act(async () => { root.render(React.createElement(React.Fragment, null, component, React.createElement(Observer))); }); };
const chips = () => [...document.querySelectorAll('[data-tag-kind]')].map(el => el.dataset.tagKind);
const assertChips = () => {
  assert.deepEqual(chips(), ['listed', 'new_domain', 'unknown']);
  assert.match(document.body.textContent, /Spamhaus DBL/);
  assert.match(document.body.textContent, /new\.example/);
  assert.match(document.body.textContent, /"ageDays":3/);
};
afterEach(async () => { if (root) await React.act(async () => root.unmount()); assert.deepEqual(useStore.getState().visibleMessageTagIds, {}); });

for (const mode of ['off', 'list']) test(`${mode === 'off' ? 'MessageRow' : 'ThreadRow'} renders only all three notable chips`, async () => {
  setup({ conversationMode: mode });
  if (mode === 'list') rows = [{ ...MSG, thread_id: 'thread-fixture', message_count: 2, unread_count: 0 }];
  await mount(React.createElement(MessageList));
  assertChips();
  assert.equal(document.querySelectorAll('[data-tag-source]').length, 0);
  assert.deepEqual(requests.at(-1).ids, [MSG.id]);
  assert.equal(requests.at(-1).headers['X-Requested-With'], 'MailFlow');
});

test('search results register their own IDs and show notable chips', async () => {
  setup();
  const result = { ...MSG, id: 'aaaaaaaa-0000-4000-8000-000000000002' };
  useStore.setState({ searchQuery: 'Tag fixture', searchResults: [result] });
  await mount(React.createElement(MessageList));
  assertChips();
  assert.deepEqual(requests.at(-1).ids, [result.id]);
});

for (const surface of ['pane', 'conversation']) test(`${surface} shows chips and four authoritative source statuses`, async () => {
  setup();
  useStore.setState({ selectedMessageId: MSG.id });
  await mount(surface === 'pane' ? React.createElement(MessagePane) : React.createElement(ConversationMessageCard, { message: MSG, expanded: false, onToggle() {}, onUpdate() {} }));
  assertChips();
  assert.deepEqual([...document.querySelectorAll('[data-tag-source]')].map(el => el.dataset.tagSource), ['rdap', 'spamhaus_dbl', 'urlhaus', 'safe_browsing']);
  for (const key of ['complete', 'inactive', 'unconfigured', 'pluginFailed']) assert.match(document.body.textContent, new RegExp(`messageTags\\.${key}`));
  await React.act(async () => useStore.setState({ showMessageTags: false }));
  assert.equal(document.querySelectorAll('[data-message-tags]').length, 0);
});

test('unhydrated and disabled preferences never register IDs or request summary', async () => {
  setup({ loaded: false });
  await mount(React.createElement(MessageTags, { messageId: MSG.id, detail: true }));
  assert.equal(requests.length, 0);
  await React.act(async () => useStore.setState({ messageTagsPreferencesLoaded: true, showMessageTags: false }));
  assert.equal(requests.length, 0);
  assert.deepEqual(useStore.getState().visibleMessageTagIds, {});
  assert.equal(document.querySelectorAll('[data-message-tags]').length, 0);
});

test('closing preference discards a pending response; reopening fetches current IDs anew', async () => {
  setup(); pending = true;
  await mount(React.createElement(MessageTags, { messageId: MSG.id, detail: true }));
  assert.equal(requests.length, 1);
  await React.act(async () => { useStore.setState({ showMessageTags: false }); resolvePending(); });
  assert.deepEqual(useStore.getState().messageTagLookup, { kind: 'ready', tags: {} });
  assert.equal(chips().length, 0);
  pending = false;
  await React.act(async () => useStore.setState({ showMessageTags: true }));
  assert.equal(requests.length, 2);
  assertChips();
});

test('duplicate mounted surfaces share one ID; leaving the visible set removes old summaries', async () => {
  setup();
  const cards = id => React.createElement(React.Fragment, null, React.createElement(MessageTags, { messageId: id }), React.createElement(MessageTags, { messageId: id, detail: true }));
  await mount(cards(MSG.id));
  assert.deepEqual(requests.at(-1).ids, [MSG.id]);
  const nextId = 'aaaaaaaa-0000-4000-8000-000000000003';
  await mount(cards(nextId));
  assert.deepEqual(Object.keys(useStore.getState().messageTagLookup.tags), [nextId]);
  assert.deepEqual(requests.at(-1).ids, [nextId]);
});

test('201 visible IDs are split at the server limit and all receive summaries', async () => {
  setup();
  const ids = Array.from({ length: 201 }, (_, index) => `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`);
  await mount(React.createElement(React.Fragment, null, ...ids.map(id => React.createElement(MessageTags, { key: id, messageId: id }))));
  assert.deepEqual(requests.map(request => request.ids.length), [200, 1]);
  assert.deepEqual(Object.keys(useStore.getState().messageTagLookup.tags).sort(), ids);
});

for (const surface of ['row', 'thread', 'pane', 'conversation']) test(`disabled preference: ${surface} has no tags and no summary requests`, async () => {
  setup({ enabled: false, conversationMode: surface === 'thread' ? 'list' : 'off' });
  if (surface === 'thread') rows = [{ ...MSG, thread_id: 'thread-fixture', message_count: 2, unread_count: 0 }];
  useStore.setState({ selectedMessageId: MSG.id });
  const component = surface === 'pane' ? React.createElement(MessagePane)
    : surface === 'conversation' ? React.createElement(ConversationMessageCard, { message: MSG, expanded: false, onToggle() {}, onUpdate() {} })
    : React.createElement(MessageList);
  await mount(component);
  assert.equal(requests.length, 0);
  assert.equal(document.querySelectorAll('[data-message-tags]').length, 0);
  assert.deepEqual(useStore.getState().visibleMessageTagIds, {});
});

test('removing one duplicate surface keeps the other registered until its own unmount', async () => {
  setup();
  await mount(React.createElement(React.Fragment, null,
    React.createElement(MessageTags, { key: 'row', messageId: MSG.id }),
    React.createElement(MessageTags, { key: 'pane', messageId: MSG.id, detail: true })));
  assert.equal(useStore.getState().visibleMessageTagIds[MSG.id], 2);
  await mount(React.createElement(React.Fragment, null, React.createElement(MessageTags, { key: 'pane', messageId: MSG.id, detail: true })));
  assert.equal(useStore.getState().visibleMessageTagIds[MSG.id], 1);
  assert.equal(requests.length, 1);
  assertChips();
});

test('unchecked states are shown in details without producing list placeholders', async () => {
  setup();
  const empty = { notable: [], sources: Object.fromEntries(Object.keys(SUMMARY.sources).map(source => [source, { kind: 'unchecked' }])) };
  globalThis.fetch = async () => json({ tags: { [MSG.id]: empty } });
  await mount(React.createElement(React.Fragment, null,
    React.createElement('section', { id: 'list' }, React.createElement(MessageTags, { messageId: MSG.id })),
    React.createElement('section', { id: 'detail' }, React.createElement(MessageTags, { messageId: MSG.id, detail: true }))));
  assert.equal(document.querySelector('#list').children.length, 0);
  assert.equal(document.querySelectorAll('#detail [data-tag-source]').length, 4);
  assert.equal(document.querySelector('#detail').textContent.match(/messageTags\.unchecked/g).length, 4);
});
