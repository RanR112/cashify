import { describe, expect, it, vi } from 'vitest';
import {
  createCategoriesService,
  mergeCategories,
  toCategoryBody,
} from '../../src/modules/categories/categories.service.js';
import type { CategoryRecord } from '../../src/modules/categories/categories.types.js';

const USER = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';

function record(overrides: Partial<CategoryRecord> & Pick<CategoryRecord, 'id' | 'slug'>): CategoryRecord {
  return {
    userId: null,
    name: overrides.slug,
    type: 'expense',
    icon: 'tag',
    color: '#112233',
    sortOrder: 1,
    ...overrides,
  };
}

describe('mergeCategories', () => {
  it('baris milik pengguna menimpa baris sistem dengan slug sama', () => {
    const merged = mergeCategories([
      record({ id: 'sys-food', slug: 'food' }),
      record({ id: 'own-food', slug: 'food', userId: USER }),
    ]);
    expect(merged.map((c) => c.id)).toEqual(['own-food']);
  });

  it('tidak bergantung pada urutan masukan', () => {
    const merged = mergeCategories([
      record({ id: 'own-food', slug: 'food', userId: USER }),
      record({ id: 'sys-food', slug: 'food' }),
    ]);
    expect(merged.map((c) => c.id)).toEqual(['own-food']);
  });

  it('kategori sistem tanpa salinan tetap tampil', () => {
    const merged = mergeCategories([
      record({ id: 'sys-food', slug: 'food' }),
      record({ id: 'sys-transport', slug: 'transport' }),
      record({ id: 'own-food', slug: 'food', userId: USER }),
    ]);
    expect(merged.map((c) => c.id).sort()).toEqual(['own-food', 'sys-transport']);
  });

  it('kategori kustom dengan slug baru ikut tampil', () => {
    const merged = mergeCategories([
      record({ id: 'sys-food', slug: 'food' }),
      record({ id: 'own-kopi', slug: 'kopi-kantor', userId: USER }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('slug yang sama beda tipe dianggap kategori berbeda', () => {
    const merged = mergeCategories([
      record({ id: 'a', slug: 'other', type: 'expense' }),
      record({ id: 'b', slug: 'other', type: 'income' }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('mempertahankan urutan kemunculan pertama', () => {
    const merged = mergeCategories([
      record({ id: 'sys-a', slug: 'a' }),
      record({ id: 'sys-b', slug: 'b' }),
      record({ id: 'own-a', slug: 'a', userId: USER }),
    ]);
    expect(merged.map((c) => c.slug)).toEqual(['a', 'b']);
  });
});

describe('toCategoryBody', () => {
  it('is_system hanya benar untuk baris tanpa pemilik, dan tanpa field internal', () => {
    expect(toCategoryBody(record({ id: 's', slug: 'food' })).is_system).toBe(true);
    const own = toCategoryBody(record({ id: 'o', slug: 'food', userId: USER }));
    expect(own.is_system).toBe(false);
    expect(Object.keys(own).sort()).toEqual(['color', 'icon', 'id', 'is_system', 'name', 'type']);
  });
});

describe('createCategoriesService.list', () => {
  it('meneruskan userId sebagai argumen pertama dan type sebagai kedua', async () => {
    const listVisibleTo = vi.fn().mockResolvedValue([record({ id: 's', slug: 'food' })]);
    const service = createCategoriesService({ listVisibleTo, listWithKeywords: vi.fn() });

    const result = await service.list(USER, 'expense');

    expect(listVisibleTo).toHaveBeenCalledWith(USER, 'expense');
    expect(result.data).toHaveLength(1);
  });
});
