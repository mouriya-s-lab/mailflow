import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { categoryIdFor, parseCategoryDrafts, OTHER_TAB_ID } from './model.js';

const draft = (key, label, id = null) => ({ key, id, label, description: 'Mail of this kind.' });

describe('category ids', () => {
  it('never generates the reserved Other id, even for a category named Other', () => {
    assert.equal(categoryIdFor('Other', new Set([OTHER_TAB_ID])), 'other-2');
    const parsed = parseCategoryDrafts([draft('added:1', 'Other'), draft('added:2', 'Personal')]);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.categories.map(c => c.id), ['other-2', 'personal']);
  });
});
