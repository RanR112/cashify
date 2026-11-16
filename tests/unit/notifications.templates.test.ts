// Template pesan notifikasi otomatis. Yang dikunci: bentuk dan batas yang sama dengan balasan
// WhatsApp (maksimal lima baris, satu emoji di awal, nominal Rp penuh, tidak ada nilai bocor),
// bukan kalimat per kalimat. Panjang maksimal 600 karakter sesuai batas pesan otomatis.

import { describe, expect, it } from 'vitest';
import {
  BUDGET_ALERT_TITLE,
  DAILY_SUMMARY_TITLE,
  budgetAlert,
  dailySummary,
  percentUsed,
} from '../../src/modules/notifications/notifications.templates.js';

const LONG_NAME = 'Kategori pengeluaran rumah tangga yang namanya sengaja sangat panjang sekali';

const samples: [string, string][] = [
  [
    'ringkasan harian',
    dailySummary({
      date: '2026-09-28',
      income: 5_000_000,
      expense: 1_240_000,
      topExpenseCategory: { name: 'Makanan', total: 520_000 },
    }),
  ],
  [
    'ringkasan tanpa transaksi',
    dailySummary({ date: '2026-09-28', income: 0, expense: 0, topExpenseCategory: null }),
  ],
  [
    'ringkasan angka besar dan nama panjang',
    dailySummary({
      date: '2026-12-31',
      income: 999_999_999_999,
      expense: 123_456_789_012,
      topExpenseCategory: { name: LONG_NAME, total: 123_456_789_012 },
    }),
  ],
  [
    'ringkasan selisih negatif',
    dailySummary({ date: '2026-01-01', income: 0, expense: 250_000 }),
  ],
  [
    'peringatan anggaran',
    budgetAlert({ budgetName: 'Anggaran Oktober', categoryName: 'Makanan', spent: 850_000, amount: 1_000_000 }),
  ],
  [
    'peringatan tanpa nama anggaran',
    budgetAlert({ budgetName: null, categoryName: 'Transportasi', spent: 100_000, amount: 400_000 }),
  ],
  [
    'peringatan nama panjang',
    budgetAlert({ budgetName: LONG_NAME, categoryName: LONG_NAME, spent: 1_500_000, amount: 1_000_000 }),
  ],
  [
    'peringatan pembagian nol',
    budgetAlert({ budgetName: 'Anggaran Kecil', categoryName: 'Lainnya', spent: 0, amount: 0 }),
  ],
];

// Satu emoji = satu grafem yang memuat piktograf, sama seperti tests/unit/whatsapp-templates.test.ts.
const segmenter = new Intl.Segmenter('id', { granularity: 'grapheme' });
const emojiGraphemes = (text: string): { index: number }[] =>
  [...segmenter.segment(text)].filter((part) => /\p{Extended_Pictographic}/u.test(part.segment));

describe('template notifikasi', () => {
  it.each(samples)('%s: maksimal lima baris dan di bawah 600 karakter', (_name, text) => {
    expect(text.trim()).not.toBe('');
    expect(text.split('\n').length).toBeLessThanOrEqual(5);
    expect(text.length).toBeLessThan(600);
  });

  it.each(samples)('%s: maksimal satu emoji dan hanya di awal', (_name, text) => {
    const found = emojiGraphemes(text);
    expect(found.length).toBeLessThanOrEqual(1);
    if (found.length === 1) expect(found[0]?.index).toBe(0);
  });

  it.each(samples)('%s: tidak ada nilai kosong yang bocor', (_name, text) => {
    expect(text).not.toMatch(/undefined|NaN|Infinity|\[object/);
  });

  it('judul singkat, tidak kosong, dan muat di kolom VARCHAR(150)', () => {
    for (const title of [DAILY_SUMMARY_TITLE, BUDGET_ALERT_TITLE]) {
      expect(title.trim()).not.toBe('');
      expect(title.length).toBeLessThanOrEqual(150);
    }
  });

  it('ringkasan harian memuat tanggal, masuk, keluar, selisih, dan kategori terbesar', () => {
    const text = dailySummary({
      date: '2026-09-28',
      income: 5_000_000,
      expense: 1_240_000,
      topExpenseCategory: { name: 'Makanan', total: 520_000 },
    });
    expect(text).toContain('Ringkasan 28 Sep');
    expect(text).toContain('Masuk: Rp5.000.000');
    expect(text).toContain('Keluar: Rp1.240.000');
    expect(text).toContain('Selisih: Rp3.760.000');
    expect(text).toContain('Terbesar: Makanan Rp520.000');
  });

  it('ringkasan tanpa transaksi tetap menulis nol, tanpa baris kategori', () => {
    const text = dailySummary({ date: '2026-09-28', income: 0, expense: 0 });
    expect(text).toContain('Masuk: Rp0');
    expect(text).toContain('Keluar: Rp0');
    expect(text).toContain('Selisih: Rp0');
    expect(text).not.toContain('Terbesar:');
    expect(text.split('\n')).toHaveLength(4);
  });

  it('selisih negatif ditulis dengan tanda minus di depan Rp', () => {
    expect(dailySummary({ date: '2026-01-01', income: 0, expense: 250_000 })).toContain('Selisih: -Rp250.000');
  });

  it('nama kategori dan anggaran yang panjang dipotong, bukan memanjangkan pesan', () => {
    const text = dailySummary({
      date: '2026-12-31',
      income: 1,
      expense: 2,
      topExpenseCategory: { name: LONG_NAME, total: 2 },
    });
    expect(text).not.toContain(LONG_NAME);
    expect(text).toContain('…');

    const alert = budgetAlert({ budgetName: LONG_NAME, categoryName: LONG_NAME, spent: 1, amount: 2 });
    expect(alert).not.toContain(LONG_NAME);
    expect(alert.length).toBeLessThan(300);
  });

  it('peringatan anggaran memuat kategori, persen, spent, alokasi, dan nama anggaran', () => {
    const text = budgetAlert({
      budgetName: 'Anggaran Oktober',
      categoryName: 'Makanan',
      spent: 850_000,
      amount: 1_000_000,
    });
    expect(text).toContain('Makanan');
    expect(text).toContain('Rp850.000 dari Rp1.000.000 (85%)');
    expect(text).toContain('Anggaran: Anggaran Oktober');
  });

  it('persen satu desimal memakai koma, dan melewati 100 bila pemakaian melebihi alokasi', () => {
    const text = budgetAlert({ budgetName: null, categoryName: 'Makanan', spent: 855_000, amount: 1_000_000 });
    expect(text).toContain('(85,5%)');
    expect(text).toContain('Anggaran: tanpa nama');
    expect(
      budgetAlert({ budgetName: 'Bulanan', categoryName: 'Makanan', spent: 1_500_000, amount: 1_000_000 }),
    ).toContain('(150%)');
  });

  it('percentUsed: pembagian nol menghasilkan 0, bukan Infinity atau NaN', () => {
    expect(percentUsed(0, 0)).toBe(0);
    expect(percentUsed(500_000, 1_000_000)).toBe(50);
    expect(percentUsed(855_000, 1_000_000)).toBe(85.5);
    expect(percentUsed(1_500_000, 1_000_000)).toBe(150);
  });
});
