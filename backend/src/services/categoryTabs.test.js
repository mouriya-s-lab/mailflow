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

  it("uses Jev's categories, in their order, followed by Other, while Jev is activated", async () => {
    jevCategoryTabs.mockResolvedValueOnce(JEV);
    const tabs = await categoryTabsFor('user-1');
    expect(tabs.kind).toBe('jev');
    expect(tabIds(tabs)).toEqual(['personal', 'review', 'other']);
    expect(jevCategoryTabs).toHaveBeenCalledWith('user-1');
  });
});

describe('tabExpr', () => {
  it('binds the current Jev category ids as one parameter, never inlined', () => {
    const tab = tabExpr({ kind: 'jev', categories: JEV }, 3, 'm');
    expect(tab.params).toEqual([['personal', 'review']]);
    expect(tab.sql).toContain('= ANY($3::text[])');
    expect(tab.sql).not.toContain('personal');
    expect(tab.sql).toContain("ELSE 'other' END");
  });

  it('binds nothing for the built-in column, which reads NULL as primary', () => {
    expect(tabExpr({ kind: 'builtin', ids: [] }, 1, 'm')).toEqual({
      sql: "COALESCE(m.category, 'primary')",
      params: [],
    });
  });
});
