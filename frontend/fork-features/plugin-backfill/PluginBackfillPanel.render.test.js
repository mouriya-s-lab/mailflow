import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

// Exercise the real panel; only its API boundary and translation rendering are controlled.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/plugin-backfill/api.js')) {
      return { format: 'module', shortCircuit: true, source: 'export const pluginBackfillApi = { status: null, start: null };' };
    }
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? k + " " + JSON.stringify(o) : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: out.code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { pluginBackfillApi } = await import('./api.js');
const PluginBackfillPanel = (await import('./PluginBackfillPanel.jsx')).default;

const accountA = { id: 'aaaaaaaa-0000-4000-8000-000000000001', emailAddress: 'a@example.invalid' };
const accountB = { id: 'aaaaaaaa-0000-4000-8000-000000000002', emailAddress: 'b@example.invalid' };
const ready = (account, backfill = { kind: 'idle' }) => ({
  ...account, status: { kind: 'available', eligibility: { kind: 'ready' }, backfill },
});
const skipped = (account, reason) => ({
  ...account, status: { kind: 'available', eligibility: { kind: 'skipped', reason }, backfill: { kind: 'idle' } },
});
const run = (over = {}) => ({
  kind: 'running', revision: 1, startedAt: '2026-10-16T10:00:00.000Z',
  marked: 127, processed: 31, failed: 6, ...over,
});
const statusPage = () => ({
  plugins: [
    { id: 'jev-classify', name: 'Jev classification', activated: false, supported: true,
      accounts: [skipped(accountA, 'plugin_inactive'), skipped(accountB, 'plugin_inactive')] },
    { id: 'tag-rdap', name: 'RDAP tags', activated: true, supported: true,
      accounts: [ready(accountA), ready(accountB)] },
    { id: 'tag-spamhaus', name: 'Spamhaus DBL tags', activated: true, supported: true,
      accounts: [ready(accountA), ready(accountB)] },
    { id: 'tag-urlhaus', name: 'URLhaus tags', activated: true, supported: true,
      accounts: [skipped(accountA, 'service_unconfigured'), skipped(accountB, 'service_unconfigured')] },
    { id: 'tag-safebrowsing', name: 'Safe Browsing tags', activated: false, supported: true,
      accounts: [skipped(accountA, 'plugin_inactive'), skipped(accountB, 'plugin_inactive')] },
  ],
});
const result = (pluginId, pluginName, account, outcome) => ({
  pluginId, pluginName, accountId: account.id, emailAddress: account.emailAddress, outcome,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const host = document.getElementById('root');
let root;
let statusCalls;
let startCalls;
let statusImpl;
let startImpl;
const text = () => host.textContent;
const pluginRow = id => host.querySelector(`[data-testid="backfill-plugin-${id}"]`);
const accountRow = (pluginId, account) => host.querySelector(`[data-testid="backfill-account-${pluginId}-${account.id}"]`);
const button = key => Array.from(host.querySelectorAll('button'))
  .find(control => control.textContent.trim() === `pluginBackfill.${key}`);
const render = async (props = {}) => {
  root = createRoot(host);
  await React.act(async () => { root.render(React.createElement(PluginBackfillPanel, props)); });
};
const unmount = async () => {
  await React.act(async () => { root.unmount(); });
  root = null;
};
const click = async control => {
  assert.ok(control, 'expected a visible panel action');
  assert.equal(control.disabled, false, 'the action must be enabled');
  await React.act(async () => {
    control.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
};
const resolve = async (pending, value) => {
  await React.act(async () => { pending.resolve(value); });
};

beforeEach(() => {
  statusCalls = [];
  startCalls = [];
  statusImpl = async () => statusPage();
  startImpl = async () => { throw new Error('unexpected start'); };
  pluginBackfillApi.status = (...args) => { statusCalls.push(args); return statusImpl(...args); };
  pluginBackfillApi.start = (...args) => { startCalls.push(args); return startImpl(...args); };
});
afterEach(async () => {
  if (root) await unmount();
  host.replaceChildren();
});

describe('PluginBackfillPanel', () => {
  test('lists all five modules including inactive Jev, and enables one start action for two ready accounts', async () => {
    await render();
    for (const plugin of statusPage().plugins) assert.ok(text().includes(plugin.name), `${plugin.name} remains visible`);
    const jev = pluginRow('jev-classify');
    assert.ok(jev, 'inactive Jev has its own visible module row');
    assert.match(jev.textContent, /pluginBackfill\.inactive/);
    assert.match(jev.textContent, /pluginBackfill\.reason\.plugin_inactive/);
    assert.match(pluginRow('tag-urlhaus').textContent, /pluginBackfill\.reason\.service_unconfigured/);
    for (const account of [accountA, accountB]) {
      assert.ok(accountRow('tag-rdap', account).textContent.includes(account.emailAddress));
      assert.match(accountRow('tag-rdap', account).textContent, /pluginBackfill\.ready/);
    }
    assert.equal(button('start').disabled, false);
    assert.equal(Array.from(host.querySelectorAll('button')).filter(control => control.textContent.trim() === 'pluginBackfill.start').length, 1);
    assert.deepEqual(statusCalls, [[]]);
    assert.deepEqual(startCalls, []);
  });

  test('submits once without client-selected IDs, shows mixed outcomes, and refreshes status from the server', async () => {
    const submission = deferred();
    const refreshedStatus = deferred();
    startImpl = () => submission.promise;
    await render();
    statusImpl = () => refreshedStatus.promise;
    await click(button('start'));
    assert.deepEqual(startCalls, [[]], 'the server enumerates the enabled plugins and accounts');
    assert.match(text(), /pluginBackfill\.starting/);
    const starting = button('starting');
    assert.ok(starting);
    assert.equal(starting.disabled, true);
    await React.act(async () => {
      starting.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(startCalls.length, 1, 'a pending submission cannot be duplicated');

    await resolve(submission, { results: [
      result('tag-rdap', 'RDAP tags', accountA, { kind: 'started', backfill: run() }),
      result('tag-rdap', 'RDAP tags', accountB, { kind: 'already_running', backfill: run({ marked: 19, processed: 3, failed: 0 }) }),
      result('tag-spamhaus', 'Spamhaus DBL tags', accountA, { kind: 'failed', error: 'start_failed' }),
      result('tag-spamhaus', 'Spamhaus DBL tags', accountB, { kind: 'skipped', reason: 'module_disabled' }),
    ] });
    assert.equal(statusCalls.length, 2, 'submission must request authoritative progress again');
    const results = host.querySelector('[data-testid="plugin-backfill-results"]');
    assert.ok(results);
    assert.match(results.textContent, /pluginBackfill\.partialFailure/);
    assert.deepEqual(Array.from(results.querySelectorAll('li'), item => item.textContent), [
      `RDAP tags · ${accountA.emailAddress}: pluginBackfill.submitted`,
      `RDAP tags · ${accountB.emailAddress}: pluginBackfill.alreadyRunning`,
      `Spamhaus DBL tags · ${accountA.emailAddress}: pluginBackfill.failed`,
      `Spamhaus DBL tags · ${accountB.emailAddress}: pluginBackfill.skipped: pluginBackfill.reason.module_disabled`,
    ], 'each server outcome stays attached to its plugin and account');

    const refreshed = statusPage();
    refreshed.plugins[1].accounts = [ready(accountA, run({
      kind: 'completed', marked: 211, processed: 207, failed: 4, finishedAt: '2026-10-16T10:05:00.000Z',
    })), ready(accountB)];
    await resolve(refreshedStatus, refreshed);
    assert.match(text(), /pluginBackfill\.completed/);
    assert.match(text(), /"marked":211/);
    assert.match(text(), /"processed":207/);
    assert.match(text(), /"failed":4/);
    assert.equal(startCalls.length, 1);
  });

  test('a failed initial GET leaves an actionable error rather than endless loading and refresh can recover', async () => {
    statusImpl = async () => { throw new Error('status unavailable'); };
    await render();
    assert.match(text(), /pluginBackfill\.loadFailed/);
    assert.match(text(), /status unavailable/);
    assert.doesNotMatch(text(), /common\.loading/, 'a rejected request is no longer loading');
    assert.equal(button('start').disabled, true, 'unknown eligibility must not permit a bulk start');
    assert.equal(button('refresh').disabled, false, 'the failed load must leave a retry action');
    assert.deepEqual(startCalls, []);

    statusImpl = async () => statusPage();
    await click(button('refresh'));
    assert.equal(statusCalls.length, 2);
    assert.doesNotMatch(text(), /pluginBackfill\.loadFailed/);
    assert.ok(text().includes('Jev classification'));
    assert.equal(button('start').disabled, false);
  });

  test('a rejected submission is shown as a failure, not a successful submission', async () => {
    startImpl = async () => { throw new Error('submission unavailable'); };
    await render();
    await click(button('start'));
    assert.deepEqual(startCalls, [[]]);
    assert.match(text(), /pluginBackfill\.startFailed/);
    assert.match(text(), /submission unavailable/);
    assert.doesNotMatch(text(), /pluginBackfill\.submitted/);
    assert.doesNotMatch(text(), /pluginBackfill\.starting/);
  });

  test('renders server run counters without treating processed or failed as marked', async () => {
    const page = statusPage();
    page.plugins[1].accounts = [ready(accountA, run()), ready(accountB, run({
      kind: 'stopped', marked: 23, processed: 11, failed: 2, stoppedAt: '2026-10-16T10:02:00.000Z',
    }))];
    statusImpl = async () => page;
    await render();
    const running = accountRow('tag-rdap', accountA).textContent;
    const stopped = accountRow('tag-rdap', accountB).textContent;
    assert.match(running, /pluginBackfill\.running/);
    assert.match(stopped, /pluginBackfill\.stopped/);
    for (const [row, counters] of [[running, { marked: 127, processed: 31, failed: 6 }], [stopped, { marked: 23, processed: 11, failed: 2 }]]) {
      for (const [key, value] of Object.entries(counters)) {
        assert.ok(row.includes(`"${key}":${value}`), `server counter ${key}=${value} is displayed for its account`);
      }
    }
  });

  test('leaving during submission does not publish a late result or request status for the closed panel', async () => {
    const submission = deferred();
    startImpl = () => submission.promise;
    await render();
    await click(button('start'));
    await unmount();
    await resolve(submission, { results: [
      result('tag-rdap', 'RDAP tags', accountA, { kind: 'started', backfill: run() }),
    ] });
    assert.deepEqual(startCalls, [[]], 'the submitted backend command is not reissued');
    assert.equal(statusCalls.length, 1, 'the closed panel must not refresh after the late submission');
    assert.equal(host.childElementCount, 0);
  });

  test('a GET slower than 15 seconds still renders and the next poll waits for its response', async context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const initial = deferred();
    statusImpl = () => initial.promise;
    await render();
    assert.match(text(), /common\.loading/);

    await React.act(async () => { context.mock.timers.tick(30_001); });
    assert.equal(statusCalls.length, 1, 'an unresolved initial GET must not be superseded by automatic polls');
    assert.match(text(), /common\.loading/);
    const first = statusPage();
    first.plugins[1].accounts = [ready(accountA, run({ marked: 400, processed: 40, failed: 3 }))];
    await resolve(initial, first);
    assert.doesNotMatch(text(), /common\.loading/, 'a slow successful response must leave loading');
    assert.match(accountRow('tag-rdap', accountA).textContent, /"processed":40/);

    const poll = deferred();
    statusImpl = () => poll.promise;
    await React.act(async () => { context.mock.timers.tick(14_999); });
    assert.equal(statusCalls.length, 1, 'the polling delay starts when the GET settles, not when it starts');
    await React.act(async () => { context.mock.timers.tick(1); });
    assert.equal(statusCalls.length, 2);
    await React.act(async () => { context.mock.timers.tick(30_001); });
    assert.equal(statusCalls.length, 2, 'a slow automatic poll must not overlap another automatic GET');

    const next = statusPage();
    next.plugins[1].accounts = [ready(accountA, run({ marked: 400, processed: 391, failed: 9 }))];
    await resolve(poll, next);
    assert.match(accountRow('tag-rdap', accountA).textContent, /"processed":391/);
    statusImpl = async () => next;
    await React.act(async () => { context.mock.timers.tick(14_999); });
    assert.equal(statusCalls.length, 2);
    await React.act(async () => { context.mock.timers.tick(1); });
    assert.equal(statusCalls.length, 3, 'successful slow polls must continue polling after their response');
  });

  test('poll updates counters and an older poll cannot replace a newer manual refresh', async context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    await render();
    const firstPoll = statusPage();
    firstPoll.plugins[1].accounts = [ready(accountA, run({ marked: 400, processed: 40, failed: 3 }))];
    statusImpl = async () => firstPoll;
    await React.act(async () => { context.mock.timers.tick(15_000); });
    assert.match(accountRow('tag-rdap', accountA).textContent, /"processed":40/);

    const olderPoll = deferred();
    statusImpl = () => olderPoll.promise;
    await React.act(async () => { context.mock.timers.tick(15_000); });
    await React.act(async () => { context.mock.timers.tick(30_001); });
    assert.equal(statusCalls.length, 3, 'the pending automatic poll must not issue overlapping GETs');
    const latest = statusPage();
    latest.plugins[1].accounts = [ready(accountA, run({ marked: 400, processed: 391, failed: 9 }))];
    statusImpl = async () => latest;
    await click(button('refresh'));
    assert.match(accountRow('tag-rdap', accountA).textContent, /"processed":391/);
    await resolve(olderPoll, firstPoll);
    assert.match(accountRow('tag-rdap', accountA).textContent, /"processed":391/);
    assert.doesNotMatch(accountRow('tag-rdap', accountA).textContent, /"processed":40(?:,|})/);
    assert.equal(statusCalls.length, 4);
    await React.act(async () => { context.mock.timers.tick(14_999); });
    assert.equal(statusCalls.length, 4, 'the superseded poll still rearms only after its own settlement');
    await React.act(async () => { context.mock.timers.tick(1); });
    assert.equal(statusCalls.length, 5, 'a newer manual response must not stop automatic polling');
    assert.match(accountRow('tag-rdap', accountA).textContent, /"processed":391/);
  });

  test('a failed slow GET shows its error and rearms polling from rejection', async context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const initial = deferred();
    statusImpl = () => initial.promise;
    await render();
    await React.act(async () => { context.mock.timers.tick(30_001); });
    assert.equal(statusCalls.length, 1);
    await React.act(async () => { initial.reject(new Error('slow status unavailable')); });
    assert.match(text(), /pluginBackfill\.loadFailed/);
    assert.match(text(), /slow status unavailable/);
    assert.doesNotMatch(text(), /common\.loading/);

    statusImpl = async () => statusPage();
    await React.act(async () => { context.mock.timers.tick(14_999); });
    assert.equal(statusCalls.length, 1);
    await React.act(async () => { context.mock.timers.tick(1); });
    assert.equal(statusCalls.length, 2, 'a rejected GET must not terminate the automatic polling loop');
    assert.doesNotMatch(text(), /pluginBackfill\.loadFailed/);
    assert.ok(pluginRow('tag-rdap'));
  });

  test('unmount cancels an already scheduled polling timeout', async context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    await render();
    assert.equal(statusCalls.length, 1);
    await React.act(async () => { context.mock.timers.tick(14_999); });
    await unmount();
    await React.act(async () => { context.mock.timers.tick(45_000); });
    assert.equal(statusCalls.length, 1, 'the armed timeout must not request status after leaving');
    assert.equal(host.childElementCount, 0);
  });

  test('polls at 15 seconds, then cleans up polling and ignores its late response after unmount', async context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    await render();
    const poll = deferred();
    statusImpl = () => poll.promise;
    await React.act(async () => { context.mock.timers.tick(14_999); });
    assert.equal(statusCalls.length, 1);
    await React.act(async () => { context.mock.timers.tick(1); });
    assert.equal(statusCalls.length, 2, 'the next server snapshot is requested at 15 seconds');
    await unmount();
    const stale = statusPage();
    stale.plugins[1].accounts = [ready(accountA, run({ marked: 999, processed: 998, failed: 1 }))];
    await resolve(poll, stale);
    await React.act(async () => { context.mock.timers.tick(45_000); });
    assert.equal(statusCalls.length, 2, 'leaving the page must stop further polling');
    assert.equal(host.childElementCount, 0, 'a late response cannot republish the closed panel');

    const current = statusPage();
    current.plugins[1].accounts = [ready(accountA, run({ marked: 811, processed: 701, failed: 5 }))];
    statusImpl = async () => current;
    await render();
    assert.match(text(), /"marked":811/);
    assert.doesNotMatch(text(), /"marked":999/);
    assert.equal(statusCalls.length, 3);
  });

  test('an old pending poll cannot publish into a new mount or rearm its timer', async context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    await render();
    const poll = deferred();
    statusImpl = () => poll.promise;
    await React.act(async () => { context.mock.timers.tick(15_000); });
    await unmount();
    const current = statusPage();
    current.plugins[1].accounts = [ready(accountA, run({ marked: 811, processed: 701, failed: 5 }))];
    statusImpl = async () => current;
    await render();
    await React.act(async () => { context.mock.timers.tick(5_000); });
    const stale = statusPage();
    stale.plugins[1].accounts = [ready(accountA, run({ marked: 999, processed: 998, failed: 1 }))];
    await resolve(poll, stale);
    assert.match(text(), /"marked":811/);
    assert.doesNotMatch(text(), /"marked":999/);
    await React.act(async () => { context.mock.timers.tick(10_000); });
    assert.equal(statusCalls.length, 4, 'the new mount keeps its own polling deadline');
    await React.act(async () => { context.mock.timers.tick(5_000); });
    assert.equal(statusCalls.length, 4, 'settling the old mount must not arm an extra poll');
  });

  test('a late initial GET cannot replace a new mount or restart its old poll', async context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const initial = deferred();
    statusImpl = () => initial.promise;
    await render();
    await unmount();
    statusImpl = async () => ({ plugins: [{
      id: 'tag-rdap', name: 'Current mount only', activated: true, supported: true, accounts: [ready(accountB)],
    }] });
    await render();
    await resolve(initial, statusPage());
    assert.ok(text().includes('Current mount only'));
    assert.ok(!text().includes('Jev classification'), 'old initial data remains outside the new mount');
    await React.act(async () => { context.mock.timers.tick(15_000); });
    assert.equal(statusCalls.length, 3, 'only the new mount may poll');
  });
});
