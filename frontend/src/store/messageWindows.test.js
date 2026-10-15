import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export default ${readFileSync(new URL(url), 'utf8')}`,
      };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
});

const originalFetch = globalThis.fetch;
let requests = [];
globalThis.fetch = (url, options = {}) => {
  const path = String(url);
  assert.equal(options.method, 'GET');
  assert.match(path, /^\/api\/mail\/messages\/[0-9a-f-]+$/);
  let resolve;
  let reject;
  const response = new Promise((resolveResponse, rejectResponse) => {
    resolve = resolveResponse;
    reject = rejectResponse;
  });
  requests.push({ path, resolve, reject });
  return response;
};

const { useStore } = await import('./index.js');

const PHYSICAL = {
  id: '10000000-0000-4000-8000-000000000001',
  uid: 17,
  account_id: 'account-a',
  account_email: 'reader@example.com',
  folder: 'Sent',
  message_id: '<delivery@example.com>',
  thread_id: 'conversation-a',
  subject: 'The exact sent message',
  from_name: 'Reader',
  from_email: 'reader@example.com',
  to_addresses: [{ name: 'Recipient', email: 'recipient@example.com' }],
  date: '2026-01-01T09:00:00Z',
  snippet: 'The sent copy has no attachment',
  has_attachments: false,
  is_read: false,
  is_starred: false,
};
const SIBLING = {
  ...PHYSICAL,
  id: '20000000-0000-4000-8000-000000000002',
  uid: 81,
  folder: 'INBOX',
  subject: 'The received sibling',
  from_name: 'Correspondent',
  from_email: 'correspondent@example.com',
  snippet: 'Only the sibling has an attachment',
  has_attachments: true,
};
const OTHER = {
  ...PHYSICAL,
  id: '30000000-0000-4000-8000-000000000003',
  message_id: '<other@example.com>',
  thread_id: 'conversation-b',
  subject: 'Another physical message',
};
const GROUPED = {
  ...SIBLING,
  id: PHYSICAL.id,
  subject: 'Grouped latest-reply subject',
  thread_count: 2,
  unread_count: 2,
};
const STASHED = { ...PHYSICAL, subject: 'Previously stashed exact-row subject' };

const windows = () => useStore.getState().messageWindows;
const windowFor = id => windows().find(entry => entry.messageId === id);
const openIds = () => windows().map(entry => entry.messageId).sort();

function succeed(request, message) {
  request.resolve({ ok: true, status: 200, json: async () => message });
}

function fail(request) {
  request.resolve({ ok: false, status: 404, json: async () => ({ error: 'Exact message unavailable' }) });
}

async function openReady(message) {
  const opening = useStore.getState().openMessageWindow(message.id);
  const request = requests.at(-1);
  assert.equal(request?.path, `/api/mail/messages/${message.id}`);
  succeed(request, message);
  assert.deepEqual(await opening, message);
  return windowFor(message.id);
}

beforeEach(() => {
  requests = [];
  localStorage.clear();
  useStore.setState({
    user: { id: 'user-a', name: 'Original name' },
    isLocked: false,
    messages: [],
    searchResults: [],
    searchQuery: '',
    threadMessages: {},
    messageWindows: [],
    selectedMessageId: null,
    selectedMessagePresentation: 'auto',
  });
});

after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});

describe('physical message window ownership', () => {
  test('loads the exact UUID instead of a grouped same-ID row or an exact-row stash', async () => {
    const store = useStore.getState();
    store.setMessages([GROUPED]);
    store.setThreadMessages(PHYSICAL.thread_id, [SIBLING]);
    store.setThreadMessages(`__dl_${PHYSICAL.id}`, [STASHED]);

    const opening = store.openMessageWindow(PHYSICAL.id);
    assert.equal(windowFor(PHYSICAL.id).content.kind, 'loading');
    assert.equal(await store.openMessageWindow(PHYSICAL.id), null, 'focusing a loading window is not a successful open');
    assert.equal(windows().length, 1);
    assert.deepEqual(requests.map(request => request.path), [`/api/mail/messages/${PHYSICAL.id}`]);

    succeed(requests[0], PHYSICAL);
    assert.deepEqual(await opening, PHYSICAL, 'the caller receives the physical row for read scheduling');
    assert.deepEqual(windowFor(PHYSICAL.id).content.message, PHYSICAL);
    assert.equal(windowFor(PHYSICAL.id).content.kind, 'ready');
  });

  for (const failure of ['HTTP refusal', 'network rejection']) {
    test(`${failure} cannot fall back to a grouped row or an exact-row stash`, async () => {
      const store = useStore.getState();
      store.setMessages([GROUPED]);
      store.setThreadMessages(`__dl_${PHYSICAL.id}`, [STASHED]);
      const opening = store.openMessageWindow(PHYSICAL.id);
      assert.equal(windowFor(PHYSICAL.id).content.kind, 'loading');
      assert.equal(requests[0]?.path, `/api/mail/messages/${PHYSICAL.id}`);

      if (failure === 'HTTP refusal') fail(requests[0]);
      else requests[0].reject(new Error('Exact message unavailable'));
      assert.equal(await opening, null, 'failure must not schedule a read against cached metadata');
      const content = windowFor(PHYSICAL.id).content;
      assert.equal(content.kind, 'error');
      assert.match(content.error, /Exact message unavailable/);
      assert.equal(content.message, undefined, 'no cached message is available to render');
      assert.equal(await store.openMessageWindow(PHYSICAL.id), null);
      assert.equal(requests.length, 1, 'focusing the error shell neither retries nor reports success');
    });
  }

  for (const staleResult of ['success', 'failure']) {
    test(`discards a delayed ${staleResult} after closing and reopening the same UUID`, async () => {
      const store = useStore.getState();
      const oldOpening = store.openMessageWindow(PHYSICAL.id);
      const oldWindow = windowFor(PHYSICAL.id);
      store.closeMessageWindow(oldWindow.winId);
      const newOpening = store.openMessageWindow(PHYSICAL.id);
      const replacement = windowFor(PHYSICAL.id);
      assert.notEqual(replacement.winId, oldWindow.winId);
      assert.equal(requests.length, 2);

      if (staleResult === 'success') succeed(requests[0], { ...PHYSICAL, subject: 'Stale request result' });
      else fail(requests[0]);
      assert.equal(await oldOpening, null);
      assert.equal(windows().length, 1);
      assert.equal(windowFor(PHYSICAL.id).winId, replacement.winId);
      assert.equal(windowFor(PHYSICAL.id).content.kind, 'loading', 'the old completion cannot populate the replacement');

      const fresh = { ...PHYSICAL, subject: 'Fresh reopened message' };
      succeed(requests[1], fresh);
      assert.deepEqual(await newOpening, fresh);
      assert.deepEqual(windowFor(PHYSICAL.id).content.message, fresh);
    });
  }

  test('retains physical metadata through minimize, list/thread refresh, restore and refocus', async () => {
    const original = await openReady(PHYSICAL);
    const store = useStore.getState();
    store.setMessageWindowMinimized(original.winId, true);
    assert.equal(windowFor(PHYSICAL.id).minimized, true);
    store.setMessages([GROUPED]);
    store.setSearchResults([GROUPED]);
    store.setThreadMessages(PHYSICAL.thread_id, [SIBLING]);
    store.setThreadMessages(`__dl_${PHYSICAL.id}`, [STASHED]);
    assert.deepEqual(windowFor(PHYSICAL.id).content.message, PHYSICAL, 'a minimized window retains its own sender, subject, flags and attachments');

    store.setMessages([]);
    store.setSearchResults([]);
    store.clearThreadMessages(PHYSICAL.thread_id);
    store.clearThreadMessages(`__dl_${PHYSICAL.id}`);
    store.setMessageWindowMinimized(original.winId, false);
    assert.equal(windowFor(PHYSICAL.id).minimized, false);
    assert.deepEqual(windowFor(PHYSICAL.id).content.message, PHYSICAL);

    store.setMessageWindowMinimized(original.winId, true);
    assert.deepEqual(await store.openMessageWindow(PHYSICAL.id), PHYSICAL);
    assert.equal(windowFor(PHYSICAL.id).minimized, false);
    assert.equal(windowFor(PHYSICAL.id).winId, original.winId);
    assert.equal(windows().length, 1);
    assert.equal(requests.length, 1, 'restore and focus do not reload the physical message');
  });

  test('updates read and star flags for the exact UUID without changing a sibling window', async () => {
    await openReady(PHYSICAL);
    const siblingWindow = await openReady(SIBLING);
    const store = useStore.getState();
    store.setMessageWindowMinimized(siblingWindow.winId, true);

    store.updateMessage(PHYSICAL.id, { is_read: true, is_starred: true });
    assert.deepEqual(windowFor(PHYSICAL.id).content.message, { ...PHYSICAL, is_read: true, is_starred: true });
    assert.deepEqual(windowFor(SIBLING.id).content.message, SIBLING, 'a shared RFC Message-ID and thread do not identify the same physical copy');

    store.updateMessage(PHYSICAL.id, { is_read: false, is_starred: false });
    store.updateMessage(SIBLING.id, { is_read: true, is_starred: true });
    assert.deepEqual(windowFor(PHYSICAL.id).content.message, PHYSICAL);
    assert.deepEqual(windowFor(SIBLING.id).content.message, { ...SIBLING, is_read: true, is_starred: true });
    assert.equal(windowFor(SIBLING.id).minimized, true, 'flag changes also reach minimized windows');
    assert.equal(requests.length, 2);
  });

  test('single removal closes only its UUID and a removed pending load cannot revive', async () => {
    await openReady(PHYSICAL);
    await openReady(SIBLING);
    const store = useStore.getState();
    const pending = store.openMessageWindow(OTHER.id);
    const pendingRequest = requests.at(-1);

    store.removeMessage(PHYSICAL.id);
    assert.deepEqual(openIds(), [SIBLING.id, OTHER.id].sort());
    assert.deepEqual(windowFor(SIBLING.id).content.message, SIBLING);
    store.removeMessage(OTHER.id);
    assert.deepEqual(openIds(), [SIBLING.id]);
    succeed(pendingRequest, OTHER);
    assert.equal(await pending, null);
    assert.deepEqual(openIds(), [SIBLING.id]);
  });

  for (const collection of ['array', 'Set']) {
    test(`bulk removal with an ${collection} closes matching UUIDs but not their conversation sibling`, async () => {
      await openReady(PHYSICAL);
      await openReady(SIBLING);
      const store = useStore.getState();
      const pending = store.openMessageWindow(OTHER.id);
      const pendingRequest = requests.at(-1);
      const ids = [PHYSICAL.id, OTHER.id];

      store.removeMessages(collection === 'Set' ? new Set(ids) : ids);
      assert.deepEqual(openIds(), [SIBLING.id]);
      assert.deepEqual(windowFor(SIBLING.id).content.message, SIBLING);
      succeed(pendingRequest, OTHER);
      assert.equal(await pending, null);
      assert.deepEqual(openIds(), [SIBLING.id]);
    });
  }

  for (const boundary of ['lock', 'logout', 'different user']) {
    test(`${boundary} closes ready and loading windows and discards the pending result`, async () => {
      await openReady(SIBLING);
      const store = useStore.getState();
      const pending = store.openMessageWindow(PHYSICAL.id);
      const pendingRequest = requests.at(-1);

      if (boundary === 'lock') store.setLocked(true);
      else store.setUser(boundary === 'logout' ? null : { id: 'user-b' });
      assert.deepEqual(openIds(), [], 'private metadata disappears at the boundary, not after the request');
      succeed(pendingRequest, PHYSICAL);
      assert.equal(await pending, null);
      assert.deepEqual(openIds(), [], 'a late response cannot reopen a private window');
    });
  }

  test('a fresh user object with the same identity preserves ready windows and in-flight loads', async () => {
    const ready = await openReady(SIBLING);
    const store = useStore.getState();
    const pending = store.openMessageWindow(PHYSICAL.id);
    const pendingRequest = requests.at(-1);
    store.setUser({ id: 'user-a', name: 'Updated profile name' });
    assert.equal(windowFor(SIBLING.id).winId, ready.winId);
    assert.deepEqual(windowFor(SIBLING.id).content.message, SIBLING);
    assert.equal(windowFor(PHYSICAL.id).content.kind, 'loading');

    succeed(pendingRequest, PHYSICAL);
    assert.deepEqual(await pending, PHYSICAL);
    assert.deepEqual(windowFor(PHYSICAL.id).content.message, PHYSICAL);
    assert.equal(requests.length, 2);
  });
});
