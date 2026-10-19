import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: 'export const useTranslation = () => ({ t: (k, o) => o ? k + " " + JSON.stringify(o) : k }); export const initReactI18next = { type: "3rdParty", init() {} };' };
    }
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path }).code };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../../store/index.js');
const { PluginSlot } = await import('../PluginSlot.jsx');
await import('./index.jsx');
const { default: ReputationTagSettings, STATUS_REFRESH_MS } = await import('./ReputationTagSettings.jsx');
const IDS = ['tag-rdap', 'tag-spamhaus', 'tag-urlhaus', 'tag-safebrowsing'];
const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const runningBackfill = { kind: 'running', revision: 0, startedAt: '2026-10-13T10:00:00Z', marked: 50, processed: 7, failed: 2 };
let states, calls, intervals, root;
const host = document.getElementById('root');
const $ = selector => host.querySelector(selector);
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const buttonTexts = scope => [...scope.querySelectorAll('button')].map(button => button.textContent);
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
beforeEach(() => {
  states = Object.fromEntries(IDS.map(id => [id, { activated: true, source: 'enabled', accounts: [{ id: ACCOUNT, emailAddress: 'fixture@example.invalid', state: 'enabled', backfill: { kind: 'idle' }, queue: { new_mail: {}, backfill: {} } }] }]));
  calls = []; intervals = new Map();
  globalThis.setInterval = (fn, ms) => { const token = Symbol('interval'); intervals.set(token, { fn, ms }); return token; };
  globalThis.clearInterval = token => intervals.delete(token);
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url), 'https://mail.example.invalid').pathname;
    const method = init.method || 'GET'; calls.push({ method, path });
    const [, pluginId, suffix] = /^\/api\/(tag-[^/]+)\/(.*)$/.exec(path) ?? [];
    assert.ok(states[pluginId], path);
    if (method !== 'GET' || suffix !== 'status') return json({ error: 'unexpected request' }, 500);
    return json(structuredClone(states[pluginId]));
  };
});
afterEach(async () => {
  if (root) await act(async () => root.unmount()); root = null;
  assert.equal(intervals.size, 0, 'disabled/unmounted settings stop polling');
  globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
});
async function mount(enabled = IDS) {
  useStore.setState({ enabledPlugins: enabled });
  root = createRoot(host);
  await act(async () => root.render(React.createElement(PluginSlot, { name: 'settings-categories', ctx: { initialSubTab: null } })));
  await flush();
}
const section = id => $(`[data-testid="settings-${id}"]`);

test('real slot gate hides disabled sources and only enabled plugins request their own status', async () => {
  await mount([]);
  assert.equal(host.textContent, ''); assert.deepEqual(calls, []);
  for (const id of IDS) {
    await act(async () => useStore.setState({ enabledPlugins: [id] })); await flush();
    assert.equal(host.querySelectorAll('section').length, 1);
    assert.ok(section(id)); assert.equal(calls.at(-1).path, `/api/${id}/status`);
  }
  await act(async () => useStore.setState({ enabledPlugins: [] }));
  assert.equal(host.textContent, ''); assert.equal(intervals.size, 0);
});

test('source states stay distinct, status polls every 15 seconds, and no per-account backfill is shown or started', async () => {
  states['tag-spamhaus'].source = 'unconfigured';
  states['tag-rdap'].source = 'disabled';
  states['tag-urlhaus'].accounts[0].backfill = runningBackfill;
  root = createRoot(host);
  await act(async () => root.render(React.createElement(React.Fragment, null,
    IDS.map(id => React.createElement(ReputationTagSettings, { key: id, pluginId: id, name: id, initialSubTab: null })))));
  await flush();
  assert.equal(section('tag-spamhaus').querySelector('[data-testid="tag-source"]').textContent, 'reputationTags.unconfigured');
  assert.equal(section('tag-rdap').querySelector('[data-testid="tag-source"]').textContent, 'reputationTags.disabled');
  assert.equal(section('tag-urlhaus').querySelector('[data-testid="tag-source"]').textContent, 'reputationTags.configured');
  for (const id of IDS) assert.deepEqual(buttonTexts(section(id)), ['reputationTags.refresh']);
  assert.doesNotMatch(host.textContent, /reputationTags\.(running|counts|start|stop)/);
  assert.equal(intervals.size, IDS.length);
  for (const { ms } of intervals.values()) assert.equal(ms, STATUS_REFRESH_MS);
  assert.ok(calls.every(call => call.method === 'GET' && call.path.endsWith('/status')));
});
