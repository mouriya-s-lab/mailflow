import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../plugins/api.js', () => ({ jevCategoryTabs: vi.fn() }));

const { jevCategoryTabs } = await import('../plugins/api.js');
const { categoryTabsFor, tabIds, tabExpr, BUILTIN_CATEGORY_IDS } = await import('./categoryTabs.js');

const JEV = [{ id: 'personal', label: 'Personal' }, { id: 'review', label: 'Review' }];

beforeEach(() => {
  jevCategoryTabs.mockReset();
});

describe('categoryTabsFor', () => {
  it('uses the built-in five while Jev is not activated for the user', async () => {
    jevCategoryTabs.mockResolvedValueOnce(null);
    const tabs = await categoryTabsFor('user-1');
    expect(tabs.kind).toBe('builtin');
    expect(tabIds(tabs)).toEqual([...BUILTIN_CATEGORY_IDS]);
  });

  it("uses Jev's own categories, in their order, while Jev is activated", async () => {
    jevCategoryTabs.mockResolvedValueOnce(JEV);
    const tabs = await categoryTabsFor('user-1');
    expect(tabs.kind).toBe('jev');
    expect(tabIds(tabs)).toEqual(['personal', 'review']);
    expect(jevCategoryTabs).toHaveBeenCalledWith('user-1');
  });
});

describe('tabExpr', () => {
  it('reads the built-in column, with NULL as primary', () => {
    expect(tabExpr({ kind: 'builtin', ids: [] }, 'm')).toBe("COALESCE(m.category, 'primary')");
  });

  it("reads Jev's recorded choice from the message annotation, never the built-in column", () => {
    const expr = tabExpr({ kind: 'jev', categories: JEV }, 'm');
    expect(expr).toBe(`(m.plugin_annotations #>> '{"jev-classify",category,decision,choice}')`);
    expect(expr).not.toContain('m.category');
  });
});
