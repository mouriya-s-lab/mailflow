import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jevOn, jevTabList, categoryTabsOn, builtinCategoryWritesOn } from './categoryTabs.js';

describe('jevOn', () => {
  it('reads the activation of the Jev plugin only', () => {
    assert.equal(jevOn(['gtd', 'jev-classify']), true);
    assert.equal(jevOn(['gtd']), false);
  });
});

describe('category switches', () => {
  it('shows the tabs for any one switch, and for Jev alone', () => {
    assert.equal(categoryTabsOn({ jev: false, globalOn: false, accountOn: false }), false);
    assert.equal(categoryTabsOn({ jev: false, globalOn: true, accountOn: false }), true);
    assert.equal(categoryTabsOn({ jev: false, globalOn: false, accountOn: true }), true);
    assert.equal(categoryTabsOn({ jev: true, globalOn: false, accountOn: false }), true);
  });

  it('offers built-in writes only while Jev is off', () => {
    assert.equal(builtinCategoryWritesOn({ jev: true, globalOn: true, accountOn: true }), false);
    assert.equal(builtinCategoryWritesOn({ jev: false, globalOn: true, accountOn: false }), true);
    assert.equal(builtinCategoryWritesOn({ jev: false, globalOn: false, accountOn: false }), false);
  });
});

describe('jevTabList', () => {
  it("lists Jev's categories in order, then Other", () => {
    assert.deepEqual(
      jevTabList([{ id: 'personal', label: 'Personal' }, { id: 'review', label: 'Review' }], 'Other'),
      [{ id: 'personal', label: 'Personal' }, { id: 'review', label: 'Review' }, { id: 'other', label: 'Other' }],
    );
  });

  it('is empty until the categories have loaded, so no tab is chosen from a partial list', () => {
    assert.deepEqual(jevTabList([], 'Other'), []);
  });
});
