// Render test for the account form's automatic Cc and Bcc lists (#491).
//
// The parsing is unit-tested in utils/autoRecipients.test.js. What only a render shows is the
// wiring: the fields show the saved lists, and Save sends both of them. A list the user did not
// touch has to go back as saved, or every unrelated edit, such as a new colour, would clear it.
//
// Same loader hooks as ProfileModal.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed so t() returns its key.

import { test, describe, before, afterEach } from 'node:test';
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
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
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
const mediaQueries = new Map();
const matchesWidth = (query) => {
  const widthQuery = query.match(/^\((min|max)-width:\s*(\d+)px\)$/);
  if (!widthQuery) return false;
  const [, bound, width] = widthQuery;
  return bound === 'max' ? window.innerWidth <= Number(width) : window.innerWidth >= Number(width);
};
const matchMedia = (query) => {
  if (!mediaQueries.has(query)) {
    const media = new dom.window.EventTarget();
    Object.assign(media, {
      media: query, matches: matchesWidth(query),
      addListener(listener) { this.addEventListener('change', listener); },
      removeListener(listener) { this.removeEventListener('change', listener); },
    });
    mediaQueries.set(query, media);
  }
  return mediaQueries.get(query);
};
function setViewportWidth(width) {
  window.innerWidth = width;
  for (const media of mediaQueries.values()) {
    const matches = matchesWidth(media.media);
    if (matches === media.matches) continue;
    media.matches = matches;
    const event = new window.Event('change');
    Object.assign(event, { matches, media: media.media });
    media.dispatchEvent(event);
  }
  window.dispatchEvent(new window.Event('resize'));
}

Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = matchMedia;
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const AdminPanel = (await import('./AdminPanel.jsx')).default;

const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
async function type(input, text) {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await React.act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

const ACCOUNT = {
  id: 'acct', name: 'Work', email_address: 'me@example.invalid', color: '#6366f1',
  imap_host: 'imap.example.invalid', imap_port: 993, auth_user: 'me@example.invalid',
  smtp_host: 'smtp.example.invalid', smtp_port: 587, smtp_tls: 'STARTTLS',
  auto_cc_addresses: ['boss@example.invalid'], auto_bcc_addresses: ['me@example.invalid'],
};

describe('account form: automatic Cc and Bcc (#491)', () => {
  const sent = [];
  let reply; // what the stubbed PUT /accounts/:id does with each request
  let root;

  before(() => {
    api.admin.getSettings = async () => ({ settings: {} });
    api.getUnreadCounts = async () => ({});
    api.updateAccount = async (id, updates) => { sent.push({ id, updates }); return reply(updates); };
  });
  afterEach(() => React.act(async () => root.unmount()));

  const field = (placeholder) => {
    const input = document.querySelector(`input[placeholder="${placeholder}"]`);
    assert.ok(input, `the form has a ${placeholder} field`);
    return input;
  };
  const save = () => click([...document.querySelectorAll('button')].find(b => b.textContent === 'admin.accounts.saveChanges'));

  // Settings > Accounts > Edit, for an account that already has both lists saved.
  async function openEdit() {
    sent.length = 0;
    useStore.setState({ user: { id: 'u1' }, accounts: [ACCOUNT], adminTab: 'accounts' });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(AdminPanel)); });
    await click(document.querySelector('button[title="common.edit"]'));
  }

  test('Save sends the edited list parsed and the untouched list as saved', async () => {
    reply = (updates) => ({ ...ACCOUNT, ...updates });
    await openEdit();
    assert.equal(field('compose.ccPh').value, 'boss@example.invalid', 'the saved Cc list is shown');
    assert.equal(field('compose.bccPh').value, 'me@example.invalid', 'the saved Bcc list is shown');

    await type(field('compose.bccPh'), 'me@example.invalid; archive@example.invalid,');
    await save();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'acct');
    assert.deepEqual(sent[0].updates.auto_cc_addresses, ['boss@example.invalid']);
    assert.deepEqual(sent[0].updates.auto_bcc_addresses, ['me@example.invalid', 'archive@example.invalid']);
  });

  test('an emptied field stays empty and Save clears that list', async () => {
    reply = (updates) => ({ ...ACCOUNT, ...updates });
    await openEdit();
    await type(field('compose.ccPh'), '');
    assert.equal(field('compose.ccPh').value, '', 'the field does not fall back to the saved list');

    await save();

    assert.deepEqual(sent[0].updates.auto_cc_addresses, []);
    assert.deepEqual(sent[0].updates.auto_bcc_addresses, ['me@example.invalid']);
  });

  test('a typed Cc list is saved parsed, and an emptied Bcc field stays empty and clears that list', async () => {
    reply = (updates) => ({ ...ACCOUNT, ...updates });
    await openEdit();
    await type(field('compose.ccPh'), 'boss@example.invalid, cfo@example.invalid');
    await type(field('compose.bccPh'), '');
    assert.equal(field('compose.bccPh').value, '', 'the field does not fall back to the saved list');

    await save();

    assert.deepEqual(sent[0].updates.auto_cc_addresses, ['boss@example.invalid', 'cfo@example.invalid']);
    assert.deepEqual(sent[0].updates.auto_bcc_addresses, []);
  });

  test('a list the server rejects shows its error, and the typed text stays', async () => {
    const error = 'Automatic Bcc: "me" is not a single email address (use name@example.com)';
    reply = () => { throw new Error(error); };
    await openEdit();
    await type(field('compose.bccPh'), 'me');
    await save();

    assert.equal(sent.length, 1);
    assert.ok(document.body.textContent.includes(error), 'the server error is shown in the form');
    assert.equal(field('compose.bccPh').value, 'me');
  });
});

describe('settings: account draft across viewport changes', () => {
  let root;

  before(() => {
    api.admin.getSettings = async () => ({ settings: {} });
  });
  afterEach(() => React.act(async () => {
    root.unmount();
    setViewportWidth(1024);
  }));

  const button = (text) => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent === text);
    assert.ok(el, `the settings view has a ${text} button`);
    return el;
  };
  const field = (labelKey) => {
    const label = [...document.querySelectorAll('label')].find(el => el.textContent.trim().startsWith(labelKey));
    assert.ok(label?.control, `the Proxy form has a ${labelKey} field`);
    return label.control;
  };
  const expectDraft = (email, name) => {
    assert.equal(button('admin.accounts.proxy.modeProxy').getAttribute('aria-pressed'), 'true', 'Proxy mode stays selected');
    assert.equal(field('admin.accounts.proxy.email').value, email, 'the unsaved email stays');
    assert.equal(field('admin.accounts.proxy.name').value, name, 'the unsaved name stays');
    assert.equal(button('admin.accounts.proxy.start').disabled, false, 'the same setup can still continue');
  };

  test('Proxy Add account keeps its mode and editable draft through 390 → 900 → 390', async () => {
    setViewportWidth(390);
    useStore.setState({ user: { id: 'u1' }, accounts: [ACCOUNT], adminTab: 'accounts' });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(AdminPanel)); });
    await click(button('admin.accounts.addButton'));
    await click(button('admin.accounts.proxy.modeProxy'));
    assert.equal(button('admin.accounts.proxy.start').disabled, true, 'setup needs an email before it can continue');
    await type(field('admin.accounts.proxy.email'), 'draft@example.invalid');
    await type(field('admin.accounts.proxy.name'), 'Unsaved mailbox');
    expectDraft('draft@example.invalid', 'Unsaved mailbox');

    await React.act(async () => { setViewportWidth(900); });
    expectDraft('draft@example.invalid', 'Unsaved mailbox');
    await type(field('admin.accounts.proxy.name'), 'Edited on desktop');
    expectDraft('draft@example.invalid', 'Edited on desktop');

    await React.act(async () => { setViewportWidth(390); });
    expectDraft('draft@example.invalid', 'Edited on desktop');
    await type(field('admin.accounts.proxy.email'), '');
    assert.equal(button('admin.accounts.proxy.start').disabled, true, 'the retained form still responds to edits');
    await type(field('admin.accounts.proxy.email'), 'continued@example.invalid');
    await type(field('admin.accounts.proxy.name'), 'Continued on mobile');
    expectDraft('continued@example.invalid', 'Continued on mobile');
  });
});
