import { describe, expect, it } from 'vitest';
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  SYSTEM_CATEGORIES,
} from '../../prisma/seed-data.js';

describe('seed kategori sistem', () => {
  it('berisi 7 kategori pengeluaran dan 5 kategori pemasukan', () => {
    expect(EXPENSE_CATEGORIES).toHaveLength(7);
    expect(INCOME_CATEGORIES).toHaveLength(5);
    expect(EXPENSE_CATEGORIES.every((c) => c.type === 'expense')).toBe(true);
    expect(INCOME_CATEGORIES.every((c) => c.type === 'income')).toBe(true);
  });

  it('slug unik di seluruh kategori sistem', () => {
    const slugs = SYSTEM_CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('kata kunci huruf kecil dan tanpa spasi berlebih', () => {
    for (const category of SYSTEM_CATEGORIES) {
      for (const keyword of category.keywords) {
        expect(keyword, `${category.slug}: "${keyword}"`).toBe(keyword.toLowerCase().trim());
        expect(keyword).not.toMatch(/\s{2,}/);
      }
    }
  });

  it('hanya kategori cadangan "Lainnya" yang boleh tanpa kata kunci', () => {
    const empty = SYSTEM_CATEGORIES.filter((c) => c.keywords.length === 0).map((c) => c.slug);
    expect(empty.sort()).toEqual(['other_expense', 'other_income']);
  });

  it('satu kata kunci tidak ambigu antar-kategori dengan tipe yang sama', () => {
    for (const group of [EXPENSE_CATEGORIES, INCOME_CATEGORIES]) {
      const seen = new Map<string, string>();
      for (const category of group) {
        for (const keyword of category.keywords) {
          expect(seen.get(keyword), `"${keyword}" ganda`).toBeUndefined();
          seen.set(keyword, category.slug);
        }
      }
    }
  });

  it('warna berformat hex 7 karakter dan slug berupa snake_case', () => {
    for (const category of SYSTEM_CATEGORIES) {
      expect(category.color).toMatch(/^#[0-9A-F]{6}$/);
      expect(category.slug).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
