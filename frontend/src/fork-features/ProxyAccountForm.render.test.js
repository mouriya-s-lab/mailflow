// Render test for the OAuth-proxy "add account" flow (fork feature).
//
// What only a render shows: the form sends the chosen provider and address,
// shows the consent link the server returned, sends back the pasted address,
// hands the created account to the parent, and keeps a pasted-address error
// retryable while a dead sign-in returns to the start.
//
// Same loader hooks as components/AdminPanel.render.test.js: node --test cannot
// parse JSX, and react-i18next is stubbed so t() returns its key.

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
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
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
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { ProxyAccountForm } = await import('./ProxyAccountForm.jsx');

const FLOW = {
  flow_id: 'f1',
  permission_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x',
  redirect_uri: 'https://localhost:7598',
};
const ACCOUNT = { id: 'a1', email_address: 'me@outlook.example', imap_host: 'emailproxy-microsoft' };

describe('OAuth-proxy add-account form', () => {
  const calls = [];
  let completeReply;
  let added;
  let root;

  before(() => {
    api.startProxyAccount = async (data) => { calls.push(['start', data]); return FLOW; };
    api.completeProxyAccount = async (flowId, url) => { calls.push(['complete', flowId, url]); return completeReply(); };
    api.cancelProxyAccount = async (flowId) => { calls.push(['cancel', flowId]); return { ok: true }; };
  });
  afterEach(() => React.act(async () => root.unmount()));

  const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  const button = (label) => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent === label);
    assert.ok(b, `a ${label} button is shown`);
    return b;
  };
  async function type(el, text) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }

  async function startFlow() {
    calls.length = 0;
    added = null;
    root = createRoot(document.getElementById('root'));
    await React.act(async () => {
      root.render(React.createElement(ProxyAccountForm, { onAdded: (a) => { added = a; }, onCancel: () => {} }));
    });
    await type(document.querySelector('input[type="email"]'), ' me@outlook.example ');
    await click(button('admin.accounts.proxy.start'));
  }

  test('start sends provider and trimmed address, then shows the consent link', async () => {
    await startFlow();
    assert.deepEqual(calls[0], ['start', { provider: 'microsoft', email_address: 'me@outlook.example', name: undefined }]);
    const link = document.querySelector('a[target="_blank"]');
    assert.equal(link?.href, FLOW.permission_url, 'the link opens the consent page');
    assert.ok(document.querySelector('textarea'), 'a field for the pasted address appears');
  });

  test('complete sends the pasted address and hands the account to the parent', async () => {
    completeReply = async () => ACCOUNT;
    await startFlow();
    await type(document.querySelector('textarea'), 'https://localhost:7598/?code=abc&state=s ');
    await click(button('admin.accounts.proxy.complete'));
    assert.deepEqual(calls[1], ['complete', 'f1', 'https://localhost:7598/?code=abc&state=s']);
    assert.deepEqual(added, ACCOUNT);
  });

  test('a wrong pasted address stays retryable; an expired sign-in returns to the start', async () => {
    completeReply = async () => {
      throw Object.assign(new Error('That address does not start with https://localhost:7598; copy the full address bar'), { status: 400 });
    };
    await startFlow();
    await type(document.querySelector('textarea'), 'https://example.invalid/');
    await click(button('admin.accounts.proxy.complete'));
    assert.match(document.querySelector('[role="alert"]').textContent, /does not start with/);
    assert.ok(document.querySelector('textarea'), 'the same sign-in can take another address');
    assert.equal(added, null);

    completeReply = async () => { throw Object.assign(new Error('Sign-in expired; start again'), { status: 404 }); };
    await click(button('admin.accounts.proxy.complete'));
    assert.equal(document.querySelector('[role="alert"]').textContent, 'Sign-in expired; start again');
    assert.equal(document.querySelector('textarea'), null, 'the expired sign-in is dropped');
    assert.ok(button('admin.accounts.proxy.start'), 'the user can start again');
  });
});
