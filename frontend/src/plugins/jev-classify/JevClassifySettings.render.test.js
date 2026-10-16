// Render test of the Jev classification settings block (mouriya-s-lab/mailflow#18) against a fake
// /api/jev-classify: activation gating, the status panel (Jev unconfigured, reputation, queue),
// retrying terminal failures, clearing incidents, the category editor's field errors, the account
// form's targets and body, backfill start/stop and the 15-second status refresh.
//
// Same loader hooks as BackupSettings.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed so t(key, values) renders the key followed by the values as JSON.
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
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
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
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

// ── The fake server ───────────────────────────────────────────────────────────

const MS = 'aaaaaaaa-0000-4000-8000-000000000001';
const GMAIL = 'aaaaaaaa-0000-4000-8000-000000000002';
const counts = (over = {}) => ({ pending: 0, retry: 0, done: 0, terminal: 0, ...over });
const accountStatus = (id, over = {}) => ({
  id, emailAddress: `${id}@example.invalid`, state: 'enabled',
  queue: { backfill: counts(), new_mail: counts() }, nextDue: { kind: 'none' }, terminalFailed: 0,
  backfill: { kind: 'idle' }, lastDecidedAt: null, jevCalls: 0, incidents: [], ...over,
});
const config = (over = {}) => ({
  enabled: true, classifyNewMail: false, routing: {}, createFolders: false, trainSpam: false, routingMinConfidence: 0.8, ...over,
});

let server;
const CALLS = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function resetServer() {
  CALLS.length = 0;
  server = {
    categories: {
      revision: 3,
      categories: [
        { id: 'work', label: 'Work', description: 'Mail about work' },
        { id: 'news', label: 'News', description: 'Newsletters' },
      ],
    },
    spamInstructions: { instructions: 'Is this email spam?', custom: false },
    accounts: [
      { id: MS, emailAddress: 'ms@example.invalid', labelStore: false, config: config(), newMailFloors: {}, folders: ['Archive', 'INBOX', 'Junk', 'MailFlow-Test/Work'] },
      { id: GMAIL, emailAddress: 'g@example.invalid', labelStore: true, config: config({ enabled: false }), newMailFloors: {}, folders: ['Inbox', 'MailFlow-Test/News'] },
    ],
    status: {
      activated: true,
      jev: { kind: 'configured', baseUrl: 'https://jev.example.invalid/v1', model: 'typesafe/jev' },
      reputation: {
        rdap: { pluginId: 'tag-rdap', activated: true, configuration: 'enabled' },
        spamhaus_dbl: { pluginId: 'tag-spamhaus', activated: false, configuration: 'unconfigured' },
        urlhaus: { pluginId: 'tag-urlhaus', activated: true, configuration: 'unconfigured' },
        safe_browsing: { pluginId: 'tag-safebrowsing', activated: false, configuration: 'disabled' },
      },
      accounts: [accountStatus(MS), accountStatus(GMAIL, { state: 'paused' })],
    },
    statusGate: null,
  };
}

const ROUTE = /^\/api\/jev-classify\/accounts\/([^/]+)(?:\/(backfill|retry-failed|incidents))?$/;
const statusOfAccount = id => server.status.accounts.find(a => a.id === id);

globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url), 'https://mail.example.invalid').pathname;
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  CALLS.push({ method, path, body });
  if (path === '/api/jev-classify/status' && method === 'GET') {
    const snapshot = structuredClone(server.status);
    if (server.statusGate) await server.statusGate();
    return json(snapshot);
  }
  if (path === '/api/jev-classify/categories') {
    if (method === 'GET') return json(server.categories);
    server.categories = { revision: server.categories.revision + 1, categories: body.categories };
    return json({ revision: server.categories.revision });
  }
  if (path === '/api/jev-classify/spam-instructions') {
    if (method === 'GET') return json(server.spamInstructions);
    server.spamInstructions = body.instructions === null
      ? { instructions: 'Is this email spam?', custom: false }
      : { instructions: body.instructions, custom: true };
    return json(server.spamInstructions);
  }
  if (path === '/api/jev-classify/accounts' && method === 'GET') return json(server.accounts);
  const match = ROUTE.exec(path);
  if (match) {
    const [, id, action] = match;
    if (!action && method === 'PUT') {
      const view = { ...server.accounts.find(a => a.id === id), config: body };
      server.accounts = server.accounts.map(a => (a.id === id ? view : a));
      return json(view);
    }
    if (action === 'backfill' && method === 'POST') {
      const run = { kind: 'running', revision: 3, startedAt: '2026-10-12T10:00:00.000Z', marked: 50, processed: 7, failed: 1 };
      statusOfAccount(id).backfill = run;
      return json({ backfill: run });
    }
    if (action === 'backfill' && method === 'DELETE') {
      const { kind, ...rest } = statusOfAccount(id).backfill;
      assert.equal(kind, 'running');
      const run = { ...rest, kind: 'stopped', stoppedAt: '2026-10-12T10:05:00.000Z' };
      statusOfAccount(id).backfill = run;
      return json({ backfill: run });
    }
    if (action === 'retry-failed' && method === 'POST') {
      const reset = statusOfAccount(id).terminalFailed;
      Object.assign(statusOfAccount(id), { terminalFailed: 0, queue: { backfill: counts({ pending: reset }), new_mail: counts() } });
      return json({ reset });
    }
    if (action === 'incidents' && method === 'DELETE') {
      statusOfAccount(id).incidents = [];
      return json({ incidents: [] });
    }
  }
  throw new Error(`unexpected fetch ${method} ${path}`);
};

// ── Rendering ─────────────────────────────────────────────────────────────────

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../../store/index.js');
const { PluginSlot } = await import('../PluginSlot.jsx');
const { getPluginMeta } = await import('../registry.js');
await import('./index.jsx');
const { default: JevClassifySettings, STATUS_REFRESH_MS } = await import('./JevClassifySettings.jsx');

const host = document.getElementById('root');
let root = null;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const until = async (check, what) => {
  for (let i = 0; i < 60; i++) { if (check()) return; await flush(); }
  assert.fail(`timed out waiting for ${what}; page shows: ${host.textContent}`);
};
const $ = selector => host.querySelector(selector);
const $$ = selector => [...host.querySelectorAll(selector)];
const buttonByText = (text, scope = host) => [...scope.querySelectorAll('button')].find(b => b.textContent === text);
const click = el => act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const statusCalls = () => CALLS.filter(c => c.path === '/api/jev-classify/status').length;
const callsTo = (method, path) => CALLS.filter(c => c.method === method && c.path === path);

async function setValue(el, value) {
  const proto = { TEXTAREA: dom.window.HTMLTextAreaElement, SELECT: dom.window.HTMLSelectElement }[el.tagName] ?? dom.window.HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

async function render(element) {
  root = createRoot(host);
  await act(async () => { root.render(element); });
  await flush();
}
async function mount() {
  await render(React.createElement(JevClassifySettings, { initialSubTab: null }));
  await until(() => $(`[data-testid="jev-status-${MS}"]`), 'the account status');
}
async function unmount() {
  if (root) await act(async () => { root.unmount(); });
  root = null;
}

beforeEach(() => { resetServer(); });
afterEach(unmount);

describe('Jev classification settings', () => {
  test('the block renders under Categories only while the plugin is activated, and the Plugins tab links to it', async () => {
    useStore.setState({ enabledPlugins: ['gtd'] });
    await render(React.createElement(PluginSlot, { name: 'settings-categories', ctx: { initialSubTab: null } }));
    assert.equal($('[data-testid="jev-classify-settings"]'), null);
    assert.equal(CALLS.length, 0, 'a deactivated plugin asks the server nothing');

    await act(async () => { useStore.setState({ enabledPlugins: ['jev-classify'] }); });
    await until(() => $('[data-testid="jev-categories"]'), 'the block after activation');
    assert.deepEqual(getPluginMeta('jev-classify').settingsLocation, { tab: 'categories', subtab: 'jev-classify', labelKey: 'admin.tabs.categories' });
  });

  test('an unconfigured Jev shows the notice; reputation sources, run states and both queues are shown', async () => {
    server.status.jev = { kind: 'unconfigured' };
    server.status.accounts[0].queue = { backfill: counts({ pending: 4, retry: 1, done: 30, terminal: 2 }), new_mail: counts({ pending: 1, done: 9 }) };
    await mount();

    assert.equal($('[data-testid="jev-unconfigured"]').textContent, 'jevClassify.service.jevUnconfigured');
    assert.deepEqual(
      ['rdap', 'spamhaus_dbl', 'urlhaus', 'safe_browsing'].map(id => $(`[data-testid="reputation-${id}"]`).textContent),
      ['RDAP: jevClassify.service.pluginActivated · jevClassify.service.sourceConfigured',
        'Spamhaus DBL: jevClassify.service.pluginInactive · jevClassify.service.sourceUnconfigured',
        'URLhaus: jevClassify.service.pluginActivated · jevClassify.service.sourceUnconfigured',
        'Google Safe Browsing: jevClassify.service.pluginInactive · jevClassify.service.sourceDisabled'],
    );
    const cells = origin => [...$(`[data-testid="jev-status-${MS}"] [data-testid="jev-queue-${origin}"]`).querySelectorAll('td')].slice(1).map(td => td.textContent);
    assert.deepEqual(cells('backfill'), ['4', '1', '30', '2']);
    assert.deepEqual(cells('new_mail'), ['1', '0', '9', '0']);
    assert.equal($(`[data-testid="jev-account-${MS}"] [data-testid="jev-run-state"]`).textContent, 'jevClassify.run.enabled');
    assert.equal($(`[data-testid="jev-account-${GMAIL}"] [data-testid="jev-run-state"]`).textContent, 'jevClassify.run.paused');
  });

  test('a configured Jev names its model and endpoint instead of the notice', async () => {
    await mount();
    assert.equal($('[data-testid="jev-unconfigured"]'), null);
    assert.match(host.textContent, /jevClassify\.service\.jevConfigured \{"model":"typesafe\/jev","baseUrl":"https:\/\/jev\.example\.invalid\/v1"\}/);
  });

  test('terminal failures show their count and Retry failed, which resets them and refetches the status', async () => {
    server.status.accounts[0].terminalFailed = 3;
    await mount();
    const card = $(`[data-testid="jev-status-${MS}"]`);
    assert.equal(card.querySelector('[data-testid="jev-terminal-failed"]').textContent, 'jevClassify.failures.count {"failed":3}');

    const before = statusCalls();
    await click(buttonByText('jevClassify.failures.retry', card));
    await until(() => !card.querySelector('[data-testid="jev-terminal-failed"]'), 'the failures to clear');
    assert.equal(callsTo('POST', `/api/jev-classify/accounts/${MS}/retry-failed`).length, 1);
    assert.equal(statusCalls(), before + 1, 'the status is fetched again after the reset');
    assert.equal(buttonByText('jevClassify.failures.retry', card), undefined);
    assert.match(card.textContent, /jevClassify\.failures\.retried \{"reset":3\}/);
    assert.deepEqual([...card.querySelector('[data-testid="jev-queue-backfill"]').querySelectorAll('td')].slice(1).map(td => td.textContent), ['3', '0', '0', '0']);
  });

  test('incidents list their Message-ID and target and are gone after Clear list', async () => {
    server.status.accounts[0].incidents = [
      { messageId: '<lost@mailflow-test.invalid>', target: 'MailFlow-Test/Work', outcome: 'moved_unlocated', at: '2026-10-12T09:00:00.000Z' },
      { messageId: null, target: 'Archive', outcome: 'moved_unlocated', at: '2026-10-12T09:01:00.000Z' },
    ];
    await mount();
    const rows = $$('[data-testid="jev-incident"]').map(tr => [...tr.querySelectorAll('td')].slice(0, 2).map(td => td.textContent));
    assert.deepEqual(rows, [['<lost@mailflow-test.invalid>', 'MailFlow-Test/Work'], ['jevClassify.incidents.noMessageId', 'Archive']]);

    await click(buttonByText('jevClassify.incidents.clear'));
    await until(() => !$('[data-testid="jev-incidents"]'), 'the incident list to clear');
    assert.equal(callsTo('DELETE', `/api/jev-classify/accounts/${MS}/incidents`).length, 1);
    assert.equal($$('[data-testid="jev-incident"]').length, 0);
  });

  test('an invalid category list shows field errors and is not sent; a valid one is saved and reloaded', async () => {
    await mount();
    const editor = $('[data-testid="jev-categories"]');
    // One category left, with an empty name.
    await click(buttonByText('jevClassify.categories.remove', editor.querySelectorAll('[data-testid="jev-category-row"]')[1]));
    await setValue(editor.querySelector('input'), '   ');
    await click(buttonByText('jevClassify.categories.save', editor));
    assert.deepEqual($$('[data-testid="jev-categories"] [data-testid="field-error"]').map(e => e.textContent), [
      'jevClassify.categories.required',
      'jevClassify.categories.sizeError {"min":2,"max":24,"current":1}',
    ]);
    assert.equal(callsTo('PUT', '/api/jev-classify/categories').length, 0, 'nothing is sent while the list is invalid');

    await setValue(editor.querySelector('input'), 'Work');
    await click(buttonByText('jevClassify.categories.add', editor));
    const added = editor.querySelectorAll('[data-testid="jev-category-row"]')[1];
    await setValue(added.querySelector('input'), 'Rechnungen & Belege');
    await setValue(added.querySelector('textarea'), 'Invoices and receipts');
    await click(buttonByText('jevClassify.categories.save', editor));
    await until(() => /jevClassify\.categories\.saved/.test(editor.textContent), 'the save confirmation');

    assert.deepEqual(callsTo('PUT', '/api/jev-classify/categories').map(c => c.body), [{
      categories: [
        { id: 'work', label: 'Work', description: 'Mail about work' },
        { id: 'rechnungen-belege', label: 'Rechnungen & Belege', description: 'Invoices and receipts' },
      ],
    }]);
    assert.equal(callsTo('GET', '/api/jev-classify/categories').length, 2, 'the stored list is read back after the save');
    assert.match(editor.textContent, /"revision":4/);
    assert.equal($$('[data-testid="jev-categories"] [data-testid="field-error"]').length, 0);
    // The accounts route the saved categories.
    assert.ok($(`[data-testid="jev-account-${MS}"] [data-testid="jev-route-rechnungen-belege"]`));
    assert.equal($(`[data-testid="jev-account-${MS}"] [data-testid="jev-route-news"]`), null);
  });

  test('the spam prompt shows the saved text, sends an edit as the user\'s own, and restores the default with null', async () => {
    await mount();
    const editor = $('[data-testid="jev-spam-instructions"]');
    const field = editor.querySelector('textarea');
    assert.equal(field.value, 'Is this email spam?');
    assert.equal(buttonByText('jevClassify.spam.restore', editor).disabled, true, 'the default has nothing to restore');

    await setValue(field, '   ');
    await click(buttonByText('jevClassify.spam.save', editor));
    assert.deepEqual($$('[data-testid="jev-spam-instructions"] [data-testid="field-error"]').map(e => e.textContent), ['jevClassify.categories.required']);
    assert.equal(callsTo('PUT', '/api/jev-classify/spam-instructions').length, 0, 'a blank prompt is not sent');

    await setValue(field, '  Is this a phishing attempt?  ');
    await click(buttonByText('jevClassify.spam.save', editor));
    await until(() => /jevClassify\.spam\.saved/.test(editor.textContent), 'the save confirmation');
    assert.deepEqual(callsTo('PUT', '/api/jev-classify/spam-instructions').map(c => c.body), [{ instructions: 'Is this a phishing attempt?' }]);
    assert.equal(buttonByText('jevClassify.spam.restore', editor).disabled, false, 'a custom prompt can be restored');

    await click(buttonByText('jevClassify.spam.restore', editor));
    await until(() => /jevClassify\.spam\.restored/.test(editor.textContent), 'the restore confirmation');
    assert.deepEqual(callsTo('PUT', '/api/jev-classify/spam-instructions').map(c => c.body), [
      { instructions: 'Is this a phishing attempt?' }, { instructions: null },
    ]);
    assert.equal($('[data-testid="jev-spam-instructions"] textarea').value, 'Is this email spam?');
  });

  test('a category saved as new-1 stays its own row when the editor is opened again and a row is added, edited and removed', async () => {
    await mount();
    let editor = $('[data-testid="jev-categories"]');
    await click(buttonByText('jevClassify.categories.add', editor));
    let rows = editor.querySelectorAll('[data-testid="jev-category-row"]');
    await setValue(rows[2].querySelector('input'), 'New 1');
    await setValue(rows[2].querySelector('textarea'), 'Original saved category description');
    await click(buttonByText('jevClassify.categories.save', editor));
    await until(() => /jevClassify\.categories\.saved/.test(editor.textContent), 'the first save');
    assert.equal(server.categories.categories[2].id, 'new-1');

    // Leave the editor and come back: everything is mounted afresh from the stored list.
    await unmount();
    await mount();
    editor = $('[data-testid="jev-categories"]');
    const rowValues = () => [...editor.querySelectorAll('[data-testid="jev-category-row"]')]
      .map(row => [row.querySelector('input').value, row.querySelector('textarea').value]);

    await click(buttonByText('jevClassify.categories.add', editor));
    rows = editor.querySelectorAll('[data-testid="jev-category-row"]');
    await setValue(rows[3].querySelector('input'), 'Discard me');
    await click(buttonByText('jevClassify.categories.remove', rows[3]));
    assert.deepEqual(rowValues().map(([label]) => label), ['Work', 'News', 'New 1'], 'removing the added row removes only it');

    await click(buttonByText('jevClassify.categories.add', editor));
    rows = editor.querySelectorAll('[data-testid="jev-category-row"]');
    await setValue(rows[3].querySelector('input'), 'Invoices');
    await setValue(rows[3].querySelector('textarea'), 'New invoices description');
    assert.deepEqual(rowValues(), [
      ['Work', 'Mail about work'], ['News', 'Newsletters'],
      ['New 1', 'Original saved category description'], ['Invoices', 'New invoices description'],
    ]);

    await click(buttonByText('jevClassify.categories.save', editor));
    await until(() => /jevClassify\.categories\.saved/.test(editor.textContent), 'the second save');
    assert.deepEqual(callsTo('PUT', '/api/jev-classify/categories').at(-1).body.categories.slice(2), [
      { id: 'new-1', label: 'New 1', description: 'Original saved category description' },
      { id: 'invoices', label: 'Invoices', description: 'New invoices description' },
    ]);
  });

  test('targets are the account\'s own folders without INBOX; an unavailable stored target blocks the save; the body has the six settings', async () => {
    server.accounts[0].config = config({ routing: { work: 'Gone/Folder', news: 'Archive', removed: 'Junk' } });
    await mount();
    const ms = $(`[data-testid="jev-account-${MS}"]`);
    const gmail = $(`[data-testid="jev-account-${GMAIL}"]`);
    const options = select => [...select.querySelectorAll('option')].map(o => [o.value, o.disabled]);

    assert.deepEqual(options(gmail.querySelector('[data-testid="jev-route-work"]')), [['', false], ['MailFlow-Test/News', false]], 'a lowercase Inbox is still INBOX');
    assert.match(gmail.textContent, /jevClassify\.accounts\.routingLabels/);
    assert.match(gmail.textContent, /jevClassify\.accounts\.createLabels/);
    assert.doesNotMatch(gmail.textContent, /jevClassify\.accounts\.routingFolders|jevClassify\.accounts\.createFolders/);
    assert.match(ms.textContent, /jevClassify\.accounts\.routingFolders/);

    const work = ms.querySelector('[data-testid="jev-route-work"]');
    assert.deepEqual(options(work), [['', false], ['Gone/Folder', true], ['Archive', false], ['Junk', false], ['MailFlow-Test/Work', false]]);
    assert.equal(work.value, 'Gone/Folder');
    await click(buttonByText('jevClassify.accounts.save', ms));
    assert.deepEqual($$(`[data-testid="jev-account-${MS}"] [data-testid="field-error"]`).map(e => e.textContent),
      ['jevClassify.accounts.unavailableTargetError {"path":"Gone/Folder"}']);
    assert.equal(callsTo('PUT', `/api/jev-classify/accounts/${MS}`).length, 0);

    await setValue(work, 'MailFlow-Test/Work');
    await click(ms.querySelectorAll('input[type="checkbox"]')[1]); // classifyNewMail
    await click(ms.querySelectorAll('input[type="checkbox"]')[3]); // trainSpam
    await setValue(ms.querySelector('[data-testid="jev-min-confidence"]'), '0.65');
    await click(buttonByText('jevClassify.accounts.save', ms));
    await until(() => /jevClassify\.accounts\.saved/.test(ms.textContent), 'the account save');

    assert.deepEqual(callsTo('PUT', `/api/jev-classify/accounts/${MS}`).map(c => c.body), [{
      enabled: true, classifyNewMail: true, routing: { work: 'MailFlow-Test/Work', news: 'Archive' },
      createFolders: false, trainSpam: true, routingMinConfidence: 0.65,
    }]);
    assert.equal(ms.querySelector('[data-testid="jev-min-confidence"]').value, '0.65');
    assert.equal(ms.querySelector('[data-testid="jev-route-work"]').value, 'MailFlow-Test/Work');
  });

  test('a confidence outside 0–1 is a field error and is not sent', async () => {
    await mount();
    const ms = $(`[data-testid="jev-account-${MS}"]`);
    await setValue(ms.querySelector('[data-testid="jev-min-confidence"]'), '1.5');
    await click(buttonByText('jevClassify.accounts.save', ms));
    assert.deepEqual($$(`[data-testid="jev-account-${MS}"] [data-testid="field-error"]`).map(e => e.textContent), ['jevClassify.accounts.minConfidenceError']);
    assert.equal(callsTo('PUT', `/api/jev-classify/accounts/${MS}`).length, 0);
  });

  test('Start backfill shows the running progress, Stop shows it stopped', async () => {
    await mount();
    const card = $(`[data-testid="jev-status-${MS}"]`);
    assert.equal(card.querySelector('[data-testid="jev-backfill"]').textContent, 'jevClassify.backfill.idle');

    await click(buttonByText('jevClassify.backfill.start', card));
    await until(() => buttonByText('jevClassify.backfill.stop', card), 'the Stop button');
    assert.equal(callsTo('POST', `/api/jev-classify/accounts/${MS}/backfill`).length, 1);
    assert.match(card.querySelector('[data-testid="jev-backfill"]').textContent, /^jevClassify\.backfill\.running \{"startedAt":".+","processed":7,"marked":50,"failed":1\}$/);

    await click(buttonByText('jevClassify.backfill.stop', card));
    await until(() => buttonByText('jevClassify.backfill.start', card), 'the Start button again');
    assert.equal(callsTo('DELETE', `/api/jev-classify/accounts/${MS}/backfill`).length, 1);
    assert.match(card.querySelector('[data-testid="jev-backfill"]').textContent, /^jevClassify\.backfill\.stopped \{"stoppedAt":".+","processed":7,"marked":50,"failed":1\}$/);
  });

  test('the status is fetched on mount and every 15 seconds until unmount, and a slow answer never replaces a newer one', async () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const timers = [];
    globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; };
    globalThis.clearInterval = id => { if (timers[id - 1]) timers[id - 1].cleared = true; };
    try {
      await mount();
      assert.equal(statusCalls(), 1, 'one fetch on mount');
      assert.deepEqual(timers.map(t => [t.ms, t.cleared]), [[STATUS_REFRESH_MS, false]]);
      assert.equal(STATUS_REFRESH_MS, 15_000);

      // The poll's answer is held back; an action's refresh answers first with newer state.
      let release;
      server.statusGate = () => new Promise(r => { release = r; });
      await act(async () => { timers[0].fn(); });
      assert.equal(statusCalls(), 2, 'the interval fetches again');
      server.statusGate = null;
      server.status.accounts[0].terminalFailed = 2;
      await act(async () => { timers[0].fn(); });
      await until(() => $('[data-testid="jev-terminal-failed"]'), 'the newer status');
      await act(async () => { release(); });
      await flush();
      assert.ok($('[data-testid="jev-terminal-failed"]'), 'the older answer arriving late is ignored');

      await unmount();
      assert.equal(timers[0].cleared, true, 'the interval stops with the block');
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });
});
