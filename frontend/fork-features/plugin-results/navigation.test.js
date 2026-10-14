// Navigation tests for stored-result rows. The implementation is exercised through the real API
// request and the real Zustand store; only fetch, the HTTP boundary, is controlled.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', {
  url: 'https://mail.example.invalid',
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
});

dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const { useStore } = await import('../../src/store/index.js');
const { openStoredResultMessage } = await import('./navigation.js');

const ACCOUNT_OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACCOUNT_NEW = 'aaaaaaaa-0000-4000-8000-000000000002';
const UUID_OLD = 'bbbbbbbb-0000-4000-8000-000000000001';
const UUID_A = 'bbbbbbbb-0000-4000-8000-000000000002';
const UUID_B = 'bbbbbbbb-0000-4000-8000-000000000003';
const SHARED_MESSAGE_ID = '<same-message-id@example.invalid>';

let calls;
let fetchImpl;

globalThis.fetch = (...args) => fetchImpl(...args);

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const liveMessage = (id, accountId, folder, over = {}) => ({
  id,
  account_id: accountId,
  folder,
  uid: 23,
  message_id: SHARED_MESSAGE_ID,
  subject: `Subject for ${id}`,
  from_name: 'Sender',
  from_email: 'sender@example.invalid',
  date: '2026-10-15T12:00:00.000Z',
  is_read: true,
  ...over,
});

const resetStore = (over = {}) => {
  useStore.setState({
    selectedAccountId: ACCOUNT_OLD,
    selectedFolder: 'OldFolder',
    selectedMessageId: UUID_OLD,
    selectedMessagePresentation: 'auto',
    showAdmin: true,
    searchQuery: '',
    searchResults: [],
    messages: [liveMessage(UUID_B, ACCOUNT_NEW, 'Archive')],
    threadMessages: {},
    ...over,
  });
};

beforeEach(() => {
  calls = [];
  fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url), 'https://mail.example.invalid');
    calls.push({ url: parsed, init });
    throw new Error(`unexpected request ${parsed.pathname}${parsed.search}`);
  };
  resetStore();
});

afterEach(() => {
  useStore.setState({ showAdmin: false, selectedMessageId: null, messages: [], searchResults: [], threadMessages: {} });
});

describe('openStoredResultMessage', () => {
  test('loads and opens the exact UUID, selects its account/folder, and closes settings', async () => {
    fetchImpl = async (url, init = {}) => {
      const parsed = new URL(String(url), 'https://mail.example.invalid');
      calls.push({ url: parsed, init });
      assert.equal(parsed.pathname, `/api/mail/messages/${UUID_A}`);
      assert.equal(init.method, 'GET');
      return response(liveMessage(UUID_A, ACCOUNT_NEW, 'Archive', { subject: 'Exact stored row' }));
    };

    const result = await openStoredResultMessage(UUID_A);

    assert.deepEqual(result, { kind: 'opened' });
    assert.deepEqual(calls.map(({ url }) => url.pathname), [`/api/mail/messages/${UUID_A}`]);
    const state = useStore.getState();
    assert.equal(state.selectedAccountId, ACCOUNT_NEW);
    assert.equal(state.selectedFolder, 'Archive');
    assert.equal(state.selectedMessageId, UUID_A);
    assert.equal(state.selectedMessagePresentation, 'single', 'exact results must bypass thread deduplication');
    assert.equal(state.showAdmin, false);
    useStore.getState().setSelectedMessage(UUID_A);
    assert.equal(useStore.getState().selectedMessagePresentation, 'auto', 'ordinary selection restores conversation handling even for the same UUID');
  });

  test('a 404 does not recover through thread or Message-ID resolution and leaves settings open', async () => {
    // UUID_B is present with the same RFC Message-ID as the missing UUID_A. It must not be used as
    // a substitute: the result row identifies a physical account/folder/UID record, not a thread.
    fetchImpl = async (url, init = {}) => {
      const parsed = new URL(String(url), 'https://mail.example.invalid');
      calls.push({ url: parsed, init });
      assert.equal(parsed.pathname, `/api/mail/messages/${UUID_A}`);
      return response({ error: 'Message not found' }, 404);
    };

    await assert.rejects(
      openStoredResultMessage(UUID_A),
      error => /Message not found/.test(error.message),
    );
    assert.deepEqual(calls.map(({ url }) => url.pathname), [`/api/mail/messages/${UUID_A}`]);
    assert.equal(useStore.getState().selectedMessageId, UUID_OLD, 'the missing UUID cannot select the same-Message-ID copy');
    assert.equal(useStore.getState().selectedAccountId, ACCOUNT_OLD);
    assert.equal(useStore.getState().selectedFolder, 'OldFolder');
    assert.equal(useStore.getState().showAdmin, true, 'a failed open does not close settings');
  });

  test('a false current guard prevents navigation and all store changes', async () => {
    const before = {
      selectedAccountId: useStore.getState().selectedAccountId,
      selectedFolder: useStore.getState().selectedFolder,
      selectedMessageId: useStore.getState().selectedMessageId,
      showAdmin: useStore.getState().showAdmin,
    };

    const result = await openStoredResultMessage(UUID_A, { isCurrent: () => false });

    assert.deepEqual(result, { kind: 'superseded' });
    assert.deepEqual(
      (({ selectedAccountId, selectedFolder, selectedMessageId, showAdmin }) => ({ selectedAccountId, selectedFolder, selectedMessageId, showAdmin }))(useStore.getState()),
      before,
    );
  });
});
