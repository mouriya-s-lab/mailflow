import { describe, it, expect } from 'vitest';
import { parseCategoriesBody, OTHER_TAB_ID } from './model.js';

const category = (id, label = id) => ({ id, label, description: `${label} mail.` });

describe('parseCategoriesBody', () => {
  it('accepts categories with ids other than the reserved Other id', () => {
    const result = parseCategoriesBody({ categories: [category('personal'), category('otherwise')] });
    expect(result.ok).toBe(true);
  });

  it('rejects the reserved Other id with a field error on that category', () => {
    const result = parseCategoriesBody({ categories: [category('personal'), category(OTHER_TAB_ID, 'Other')] });
    expect(result.ok).toBe(false);
    expect(result.fields).toEqual({ 'categories[1].id': '"other" is reserved for the Other tab' });
  });
});
