import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectedMessage, topOpenMessageWindow, markMessageUnread } from './messageHotkeys.js';
import { openForwardFromMessage } from './composeFromMessage.js';

describe('selected message hotkeys', () => {
  const inbox = { id: 'inbox', account_id: 'acct', is_read: true, category: 'primary' };
  const rail = { id: 'rail', account_id: 'acct', is_read: true };

  it('resolves normal, search, thread, and GTD rail selections; no selection is a no-op', () => {
    assert.equal(selectedMessage({ selectedMessageId: 'inbox', messages: [inbox], searchResults: [], searchQuery: '', threadMessages: {} }), inbox);
    assert.equal(selectedMessage({ selectedMessageId: 'rail', messages: [inbox], searchResults: [], searchQuery: '', threadMessages: {}, gtdSections: { todo: { threads: [rail] } } }), rail);
    assert.equal(selectedMessage({ selectedMessageId: 'rail', messages: [], searchResults: [rail], searchQuery: 'q', threadMessages: {} }), rail);
    assert.equal(selectedMessage({ selectedMessageId: 'rail', messages: [], threadMessages: { thread: [rail] } }), rail);
    assert.equal(selectedMessage({ selectedMessageId: null, messages: [inbox] }), null);
  });

  it('uses the frontmost open message window when the main list has no selection', () => {
    const behind = { id: 'behind', account_id: 'acct' };
    const front = { id: 'front', account_id: 'acct' };
    const state = {
      selectedMessageId: null, messages: [],
      messageWindows: [
        { messageId: 'behind', z: 3, minimized: false, content: { kind: 'ready', message: behind } },
        { messageId: 'front', z: 5, minimized: false, content: { kind: 'ready', message: front } },
      ],
    };
    assert.equal(selectedMessage(state), front);
    assert.equal(topOpenMessageWindow(state), state.messageWindows[1]);
    assert.equal(selectedMessage({ ...state, messageWindows: state.messageWindows.map(w => ({ ...w, minimized: w.messageId === 'front' })) }), behind);
    assert.equal(selectedMessage({ ...state, messageWindows: state.messageWindows.map(w => ({ ...w, minimized: true })) }), null);
  });

  it('uses exact window metadata and physical UUID when forwarding, not a grouped row with the same UUID', async () => {
    const exact = {
      id: 'physical-uuid', account_id: 'acct', subject: 'Exact physical message',
      folder: 'Projects', thread_id: 'thread', message_count: 1,
    };
    const grouped = { ...exact, subject: 'Wrong grouped subject', message_count: 8 };
    const state = {
      selectedMessageId: null, messages: [grouped],
      messageWindows: [
        { messageId: exact.id, z: 1, minimized: false, content: { kind: 'ready', message: exact } },
      ],
    };
    const message = selectedMessage(state);
    assert.equal(message, exact);
    const fetched = [];
    const drafts = [];
    await openForwardFromMessage(message, {
      getMessageBody: async id => {
        fetched.push(id);
        return { text: 'Exact body', attachments: [{ part: '2', filename: 'exact.txt', type: 'text/plain', size: 10 }] };
      },
      openCompose: draft => drafts.push(draft),
    });
    assert.deepEqual(fetched, ['physical-uuid']);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].subject, 'Fwd: Exact physical message');
    assert.match(drafts[0].quotedBody, /Subject: Exact physical message/);
    assert.doesNotMatch(drafts[0].quotedBody, /Wrong grouped subject/);
    assert.deepEqual(drafts[0].forwardedAttachments, [
      { messageId: 'physical-uuid', part: '2', filename: 'exact.txt', type: 'text/plain', size: 10 },
    ]);
  });

  it('preserves explicit main-list selection ahead of ready, loading, and failed windows', () => {
    const exact = { id: 'inbox', account_id: 'acct', subject: 'Exact window subject' };
    for (const content of [
      { kind: 'ready', message: exact },
      { kind: 'loading' },
      { kind: 'error', error: 'Message unavailable' },
    ]) {
      assert.equal(selectedMessage({
        selectedMessageId: 'inbox', messages: [inbox],
        messageWindows: [{ messageId: exact.id, z: 1, minimized: false, content }],
      }), inbox, content.kind);
    }
  });

  it('does not resolve loading or failed windows from any cache or a lower ready window', () => {
    for (const content of [
      { kind: 'loading' },
      { kind: 'error', error: 'Message unavailable' },
    ]) {
      const state = {
        selectedMessageId: null, messages: [inbox], searchQuery: 'subject', searchResults: [inbox],
        threadMessages: { thread: [inbox] }, gtdSections: { todo: { threads: [inbox] } },
        messageWindows: [
          { messageId: rail.id, z: 1, minimized: false, content: { kind: 'ready', message: rail } },
          { messageId: inbox.id, z: 2, minimized: false, content },
        ],
      };
      assert.equal(topOpenMessageWindow(state), state.messageWindows[1], content.kind);
      assert.equal(selectedMessage(state), null, content.kind);
    }
  });

  it('explicit unread cancels a pending auto-read, even if row is still unread', async () => {
    const calls = [];
    const cancel = () => calls.push('cancel');
    const patch = async (ids, read) => calls.push(['patch', ids, read]);
    assert.equal(markMessageUnread({ ...inbox, is_read: false }, { cancel, patch }), true);
    assert.deepEqual(calls, ['cancel']);
    assert.equal(markMessageUnread(inbox, {
      cancel,
      update: (id, data) => calls.push(['update', id, data]),
      incrementUnread: () => calls.push('increment'),
      adjustCategoryCount: () => calls.push('category'),
      patch,
    }), true);
    await Promise.resolve();
    assert.deepEqual(calls.slice(1), ['cancel', ['update', 'inbox', { is_read: false }], 'increment', 'category', ['patch', ['inbox'], false]]);
  });
});
