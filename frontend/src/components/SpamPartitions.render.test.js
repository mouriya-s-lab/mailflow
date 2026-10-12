import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

// Match the settings render tests: transform JSX and expose translation keys in the DOM.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: k => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  __VITE_ENV__: { MODE: 'test', DEV: false, PROD: true },
});
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { spamApi } = await import('../utils/spamApi.js');
const SpamSettings = (await import('./SpamSettings.jsx')).default;
const SpamExplainModal = (await import('./SpamExplainModal.jsx')).default;
const host = document.getElementById('root');
let root;
afterEach(async () => { if (root) await React.act(async () => root.unmount()); });

async function mount(Component, props = {}) {
  root = createRoot(host);
  await React.act(async () => { root.render(React.createElement(Component, props)); });
}
async function settings(partitions, modelVersion = 2) {
  spamApi.getStatus = async () => ({ masterEnabled: true, modelVersion, decayThresholdDays: 120, partitions });
  spamApi.getThresholds = async () => ({ spamThreshold: 0.8, autoMoveThreshold: 0.9 });
  spamApi.getDecayThreshold = async () => ({ decayThresholdDays: 120 });
  spamApi.getDeletions = async () => [];
  await mount(SpamSettings);
}
const PARTITIONS = [
  { language: 'zh', trainingRecords: 501, maturity: 'mature', lastTrainedAt: '2026-10-11T12:00:00Z' },
  { language: 'en', trainingRecords: 50, maturity: 'fresh', lastTrainedAt: null },
  { language: 'und-Latn', trainingRecords: 49, maturity: 'insufficient', lastTrainedAt: null },
];

test('model status renders only per-language rows with their own counts, maturity and training time', async () => {
  await settings(PARTITIONS);
  assert.deepEqual([...host.querySelectorAll('thead th')].map(th => th.textContent), [
    'spam.statLanguage', 'spam.statRecords', 'spam.statMaturity', 'spam.statLastTrained',
  ]);
  const rows = [...host.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent));
  assert.deepEqual(rows, PARTITIONS.map(p => [p.language, String(p.trainingRecords), `spam.maturity.${p.maturity}`,
    p.lastTrainedAt ? new Date(p.lastTrainedAt).toLocaleString() : 'spam.never']));
  assert.ok(host.textContent.includes('spam.statVersion2'));
  assert.ok(host.textContent.includes('spam.statDecay120 spam.days'));
  assert.ok(!host.textContent.includes('undefined'));
  assert.ok(!host.textContent.includes('spam.noLanguageModels'));
});

test('an empty partition list explains the next retrain and retains the unknown version and decay stats', async () => {
  await settings([], null);
  assert.equal(host.querySelector('table'), null);
  assert.ok(host.textContent.includes('spam.noLanguageModels'));
  assert.ok(host.textContent.includes('spam.statVersion—'));
  assert.ok(host.textContent.includes('spam.statDecay120 spam.days'));
});

async function explain(partition) {
  spamApi.explain = async id => {
    assert.equal(id, 'message-1');
    return { verdict: 'spam', method: 'blended', mlProbability: 0.93, partition,
      rulesFired: [{ name: 'test rule', weight: 2 }], mlTopTokens: [{ token: 'test token', contribution: 1.5 }] };
  };
  await mount(SpamExplainModal, { messageId: 'message-1', onClose() {} });
}

test('explain renders the verdict partition verbatim with its record count and maturity and keeps existing details', async () => {
  await explain({ language: 'und-Latn', trainingRecords: 49, maturity: 'insufficient' });
  assert.ok(host.textContent.includes('spam.explainPartitionTitle'));
  assert.ok(host.textContent.includes('spam.statLanguage: und-Latn'));
  assert.ok(host.textContent.includes('spam.statRecords: 49'));
  assert.ok(host.textContent.includes('spam.statMaturity: spam.maturity.insufficient'));
  assert.ok(!host.textContent.includes('spam.explainLegacyPartition'));
  assert.ok(host.textContent.includes('spam.verdict.spam'));
  assert.ok(host.textContent.includes('spam.method.blended'));
  assert.ok(host.textContent.includes('93%'));
  assert.ok(host.textContent.includes('test rule'));
  assert.ok(host.textContent.includes('test token'));
});

test('explain identifies a verdict saved before per-language models without inventing a partition', async () => {
  await explain(null);
  assert.ok(host.textContent.includes('spam.explainLegacyPartition'));
  assert.ok(!host.textContent.includes('spam.statLanguage:'));
  assert.ok(host.textContent.includes('spam.verdict.spam'));
});
