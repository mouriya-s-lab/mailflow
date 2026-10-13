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
const { STATUS_REFRESH_MS } = await import('./ReputationTagSettings.jsx');
const IDS = ['tag-rdap', 'tag-spamhaus', 'tag-urlhaus', 'tag-safebrowsing'];
const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const run = (kind = 'running', processed = 7) => ({ kind, revision: 0, startedAt: '2026-10-13T10:00:00Z', marked: 50, processed, failed: 2, ...(kind === 'completed' ? { finishedAt: '2026-10-13T11:00:00Z' } : {}), ...(kind === 'stopped' ? { stoppedAt: '2026-10-13T10:30:00Z' } : {}) });
let states, calls, refusal, statusGate, intervals, root;
const host = document.getElementById('root');
const $ = selector => host.querySelector(selector);
const button = (key, scope = host) => [...scope.querySelectorAll('button')].find(el => el.textContent === `reputationTags.${key}`);
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const click = el => act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
beforeEach(() => {
  states = Object.fromEntries(IDS.map(id => [id, { activated: true, source: 'enabled', accounts: [{ id: ACCOUNT, emailAddress: 'fixture@example.invalid', state: 'enabled', backfill: { kind: 'idle' }, queue: { new_mail: {}, backfill: {} } }] }]));
  calls = []; refusal = null; statusGate = null; intervals = new Map();
  globalThis.setInterval = (fn, ms) => { const token = Symbol('interval'); intervals.set(token, { fn, ms }); return token; };
  globalThis.clearInterval = token => intervals.delete(token);
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url), 'https://mail.example.invalid').pathname;
    const method = init.method || 'GET'; calls.push({ method, path });
    const [, pluginId, suffix] = /^\/api\/(tag-[^/]+)\/(.*)$/.exec(path) ?? [];
    assert.ok(states[pluginId], path);
    if (method === 'GET' && suffix === 'status') {
      const snapshot = structuredClone(states[pluginId]);
      if (statusGate) { const gate = statusGate; statusGate = null; await gate; }
      return json(snapshot);
    }
    assert.equal(suffix, `accounts/${ACCOUNT}/backfill`);
    if (refusal) { const { status, body, update } = refusal; refusal = null; update?.(states[pluginId]); return json(body, status); }
    if (method === 'POST') states[pluginId].accounts[0].backfill = run();
    else if (method === 'DELETE') states[pluginId].accounts[0].backfill = run('stopped');
    else assert.fail(method);
    return json({ backfill: states[pluginId].accounts[0].backfill });
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
const counts = id => section(id).querySelector('[data-testid="tag-counts"]').textContent;

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

test('configured, unconfigured and admin-disabled sources remain distinct and stop remains available', async () => {
  states['tag-spamhaus'].source = 'unconfigured';
  states['tag-rdap'].source = 'disabled';
  states['tag-rdap'].accounts[0].backfill = run();
  await mount();
  assert.equal(section('tag-spamhaus').querySelector('[data-testid="tag-source"]').textContent, 'reputationTags.unconfigured');
  assert.equal(section('tag-rdap').querySelector('[data-testid="tag-source"]').textContent, 'reputationTags.disabled');
  assert.equal(section('tag-urlhaus').querySelector('[data-testid="tag-source"]').textContent, 'reputationTags.configured');
  assert.equal(button('start', section('tag-spamhaus')).disabled, true);
  assert.equal(button('stop', section('tag-rdap')).disabled, false);
});

test('all backfill variants display exactly their counters, including completed and stopped', async () => {
  IDS.forEach((id, i) => { states[id].accounts[0].backfill = i === 0 ? { kind: 'idle' } : run(['idle', 'running', 'completed', 'stopped'][i]); });
  await mount();
  assert.equal(section('tag-rdap').querySelector('[data-testid="tag-counts"]'), null);
  for (const id of IDS.slice(1)) assert.equal(counts(id), 'reputationTags.counts {"marked":50,"processed":7,"failed":2}');
  assert.match(section('tag-urlhaus').textContent, /reputationTags.completed/);
  assert.match(section('tag-safebrowsing').textContent, /reputationTags.stopped/);
});

test('start and stop refresh authority; stopped counters keep changing and persist on remount', async () => {
  await mount(['tag-urlhaus']);
  await click(button('start'));
  assert.deepEqual(calls.slice(-2), [{ method: 'POST', path: `/api/tag-urlhaus/accounts/${ACCOUNT}/backfill` }, { method: 'GET', path: '/api/tag-urlhaus/status' }]);
  assert.match(host.textContent, /reputationTags.running/);
  await click(button('stop'));
  assert.match(host.textContent, /reputationTags.stopped/);
  states['tag-urlhaus'].accounts[0].backfill.processed = 11;
  assert.equal([...intervals.values()][0].ms, STATUS_REFRESH_MS);
  await act(async () => [...intervals.values()][0].fn());
  assert.equal(counts('tag-urlhaus'), 'reputationTags.counts {"marked":50,"processed":11,"failed":2}');
  await act(async () => root.unmount()); root = null;
  await mount(['tag-urlhaus']);
  assert.match(host.textContent, /reputationTags.stopped/);
  assert.equal(counts('tag-urlhaus'), 'reputationTags.counts {"marked":50,"processed":11,"failed":2}');
});

test('start conflict shows refusal and the refreshed running record rather than optimistic state', async () => {
  await mount(['tag-urlhaus']);
  refusal = { status: 409, body: { error: 'A backfill is already running', backfill: run() }, update: state => { state.accounts[0].backfill = run(); } };
  await click(button('start'));
  assert.match(host.textContent, /reputationTags.startConflict/);
  assert.match(host.textContent, /reputationTags.running/);
  assert.ok(button('stop'));
});

test('stop conflict, account ownership refusal and server failures are not shown as success', async () => {
  states['tag-urlhaus'].accounts[0].backfill = run();
  await mount(['tag-urlhaus']);
  refusal = { status: 409, body: { error: 'No backfill is running' }, update: state => { state.accounts[0].backfill = run('completed'); } };
  await click(button('stop'));
  assert.match(host.textContent, /reputationTags.stopConflict/); assert.match(host.textContent, /reputationTags.completed/);
  const account = states['tag-urlhaus'].accounts[0];
  refusal = { status: 404, body: { error: 'Account not found' }, update: state => { state.accounts = []; } };
  await click(button('start'));
  assert.match(host.textContent, /reputationTags.accountNotFound/);
  assert.equal($(`[data-testid="tag-account-${ACCOUNT}"]`), null, 'the inaccessible account disappears without swallowing its refusal');
  states['tag-urlhaus'].accounts = [account];
  await click(button('refresh'));
  refusal = { status: 500, body: { error: 'Internal server error' } };
  await click(button('start'));
  assert.match(host.textContent, /reputationTags.actionFailed/);
  assert.match(host.textContent, /Internal server error/);
});

test('an older poll resolving after action refresh cannot overwrite the stopped record', async () => {
  states['tag-urlhaus'].accounts[0].backfill = run();
  await mount(['tag-urlhaus']);
  let release;
  statusGate = new Promise(resolve => { release = resolve; });
  const poll = [...intervals.values()][0].fn();
  await click(button('stop'));
  assert.match(host.textContent, /reputationTags.stopped/);
  await act(async () => { release(); await poll; });
  assert.match(host.textContent, /reputationTags.stopped/);
  assert.ok(button('start'));
});
