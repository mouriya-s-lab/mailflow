import test from 'node:test';
import assert from 'node:assert/strict';
import * as applicability from './shortcutApplicability.js';

const { canRunSelectedAction, canRunGlobalAction, canHandlePaneShortcut } = applicability;

const selected = { selectedMessageId: 'm1', messages: [{ id: 'm1', account_id: 'a1' }] };

test('selected-row actions leave browser behavior alone without a selection', () => {
  for (const action of ['markUnread', 'forward', 'replyAllFromSelection', 'unsubscribe', 'loadRemoteImages', 'openLabelPicker', 'reply', 'replyAll', 'toggleStar', 'printMessage', 'toggleRead', 'selectMessage']) {
    assert.equal(canRunSelectedAction(action, { ...selected, selectedMessageId: null }), false, action);
    assert.equal(canRunSelectedAction(action, selected), true, action);
  }
  assert.equal(canRunSelectedAction('compose', { ...selected, selectedMessageId: null }), true);
});

test('right sidebar toggle only captures a key when its sidebar is rendered', () => {
  assert.equal(canRunGlobalAction('toggleRightSidebar', { rightSidebarApplicable: false }), false);
  assert.equal(canRunGlobalAction('toggleRightSidebar', { rightSidebarApplicable: true }), true);
  assert.equal(canRunGlobalAction('compose', { rightSidebarApplicable: false }), true);
});

test('frontmost open message window enables its pane actions without a main selection', () => {
  const front = { id: 'front', account_id: 'a1' };
  const behind = { id: 'behind', account_id: 'a1' };
  const popout = {
    selectedMessageId: null,
    messages: [],
    messageWindows: [
      { messageId: 'behind', z: 2, minimized: false, content: { kind: 'ready', message: behind } },
      { messageId: 'front', z: 4, minimized: false, content: { kind: 'ready', message: front } },
    ],
  };
  for (const action of ['reply', 'replyAll', 'forward', 'replyAllFromSelection', 'toggleStar', 'printMessage', 'markUnread', 'openLabelPicker']) {
    assert.equal(canRunSelectedAction(action, popout), true, action);
  }
  for (const action of ['unsubscribe', 'loadRemoteImages', 'selectMessage']) {
    assert.equal(canRunSelectedAction(action, popout), false, action);
  }
  assert.equal(canHandlePaneShortcut('front', popout), true);
  assert.equal(canHandlePaneShortcut('behind', popout), false);
  assert.equal(canHandlePaneShortcut(null, popout), false);
});

test('loading and failed windows do not enable selected-message actions from cached rows', () => {
  for (const content of [
    { kind: 'loading' },
    { kind: 'error', error: 'Message unavailable' },
  ]) {
    const state = {
      ...selected, selectedMessageId: null,
      messageWindows: [
        { messageId: 'behind', z: 1, minimized: false, content: { kind: 'ready', message: { id: 'behind', account_id: 'a1' } } },
        { messageId: 'm1', z: 2, minimized: false, content },
      ],
    };
    for (const action of ['reply', 'replyAll', 'forward', 'replyAllFromSelection', 'toggleStar', 'printMessage', 'markUnread', 'openLabelPicker']) {
      assert.equal(canRunSelectedAction(action, state), false, `${content.kind}: ${action}`);
    }
  }
});

test('an explicit selected row retains its actions regardless of detached window content', () => {
  for (const content of [
    { kind: 'ready', message: { id: 'other', account_id: 'a2' } },
    { kind: 'loading' },
    { kind: 'error', error: 'Message unavailable' },
  ]) {
    const state = {
      ...selected,
      messageWindows: [{ messageId: 'other', z: 1, minimized: false, content }],
    };
    for (const action of ['reply', 'replyAll', 'forward', 'replyAllFromSelection', 'toggleStar', 'printMessage', 'markUnread', 'openLabelPicker', 'unsubscribe', 'loadRemoteImages', 'selectMessage']) {
      assert.equal(canRunSelectedAction(action, state), true, `${content.kind}: ${action}`);
    }
  }
});

test('GTD shortcuts only capture keys for an active plugin and eligible live selected account', () => {
  const active = { ...selected, enabledPlugins: ['gtd'], accounts: [{ id: 'a1', gtd_enabled: true }] };
  for (const action of ['gtdTodo', 'gtdWatch', 'gtdDelegated', 'gtdReference', 'gtdSomeday', 'gtdDone']) {
    assert.equal(canRunSelectedAction(action, active), true, action);
    assert.equal(canRunSelectedAction(action, { ...active, enabledPlugins: [] }), false, action);
    assert.equal(canRunSelectedAction(action, { ...active, accounts: [{ id: 'a1', gtd_enabled: false }] }), false, action);
    assert.equal(canRunSelectedAction(action, { ...active, selectedMessageId: null }), false, action);
    assert.equal(canRunSelectedAction(action, { ...active, selectedMessageId: 'removed-rail' }), false, action);
  }
});
