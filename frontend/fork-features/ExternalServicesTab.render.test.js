// Render test for the external service settings (fork feature).
//
// What only a render shows: a stored key comes back as the mask and is sent back unchanged when
// the admin edits something else, an emptied key field is sent as an empty string (which removes
// the key), the status line follows what the server stored, and the RDAP switch is sent as a boolean.
//
// Same loader hooks as ProxyAccountForm.render.test.js: node --test cannot parse JSX, and
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
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { serviceConfigApi } = await import('./api.js');
const { ExternalServicesTab } = await import('./ExternalServicesTab.jsx');

const MASK = '••••••••';
const JEV = { baseUrl: 'https://api.commandcode.ai/provider/v1/systemone', model: 'typesafe/jev' };
const NO_KEYS = { spamhausDqsKey: '', urlhausAuthKey: '', safeBrowsingApiKey: '' };

describe('external service settings', () => {
  const calls = [];
  let jev;
  let reputation;
  let root;

  before(() => {
    serviceConfigApi.getJev = async () => ({ config: jev });
    serviceConfigApi.saveJev = async (data) => {
      calls.push(['jev', data]);
      jev = { baseUrl: data.baseUrl, model: data.model, apiKey: data.apiKey === '' ? '' : MASK };
      return { ok: true, config: jev };
    };
    serviceConfigApi.getReputation = async () => ({ config: reputation });
    serviceConfigApi.saveReputation = async (data) => {
      calls.push(['reputation', data]);
      reputation = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' && v ? MASK : v]));
      return { ok: true, config: reputation };
    };
  });
  afterEach(() => React.act(async () => root.unmount()));

  async function render() {
    calls.length = 0;
    root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(ExternalServicesTab)); });
  }
  const input = (id) => document.getElementById(id);
  const status = () => document.querySelector('[data-testid="jev-status"]').textContent;
  const submit = (index) => React.act(async () => {
    document.querySelectorAll('form')[index].dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  async function type(el, text) {
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, text);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }

  test('a new Jev key is sent as typed and the status turns configured', async () => {
    jev = { ...JEV, apiKey: '' };
    reputation = { rdapEnabled: true, ...NO_KEYS };
    await render();
    assert.equal(input('fork-jev-base-url').value, JEV.baseUrl, 'the endpoint is prefilled');
    assert.equal(input('fork-jev-model').value, JEV.model, 'the model is prefilled');
    assert.equal(status(), 'admin.externalServices.jev.unconfigured');
    await type(input('fork-jev-api-key'), 'new-key');
    assert.equal(status(), 'admin.externalServices.jev.unconfigured', 'typing alone does not claim a stored key');
    await submit(0);
    assert.deepEqual(calls, [['jev', { ...JEV, apiKey: 'new-key' }]]);
    assert.equal(status(), 'admin.externalServices.jev.configured');
    assert.equal(input('fork-jev-api-key').value, MASK, 'the stored key shows as the mask');
  });

  test('changing only the model sends the mask back; clearing the key sends an empty string', async () => {
    jev = { ...JEV, apiKey: MASK };
    reputation = { rdapEnabled: true, ...NO_KEYS };
    await render();
    assert.equal(status(), 'admin.externalServices.jev.configured');
    await type(input('fork-jev-model'), 'typesafe/jev-next');
    await submit(0);
    assert.deepEqual(calls[0], ['jev', { ...JEV, model: 'typesafe/jev-next', apiKey: MASK }]);
    await type(input('fork-jev-api-key'), '');
    await submit(0);
    assert.deepEqual(calls[1], ['jev', { ...JEV, model: 'typesafe/jev-next', apiKey: '' }]);
    assert.equal(status(), 'admin.externalServices.jev.unconfigured');
  });

  test('the RDAP switch and optional keys are sent with the other keys kept', async () => {
    jev = { ...JEV, apiKey: '' };
    reputation = { rdapEnabled: true, ...NO_KEYS, urlhausAuthKey: MASK };
    await render();
    const rdap = document.querySelector('[role="switch"]');
    assert.equal(rdap.getAttribute('aria-checked'), 'true');
    await click(rdap);
    await type(input('fork-reputation-spamhausDqsKey'), 'dqs-key');
    await submit(1);
    assert.deepEqual(calls, [['reputation', { rdapEnabled: false, spamhausDqsKey: 'dqs-key', urlhausAuthKey: MASK, safeBrowsingApiKey: '' }]]);
    assert.equal(rdap.getAttribute('aria-checked'), 'false');
  });
});
