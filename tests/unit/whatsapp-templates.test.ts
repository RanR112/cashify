// Template balasan WhatsApp (src/modules/whatsapp/whatsapp.templates.ts). Yang dikunci: nada dan
// bentuk yang ditetapkan P15 untuk SEMUA balasan, bukan kalimat per kalimat (kalimat boleh diperbaiki
// tanpa mengubah test ini).
//   - maksimal 5 baris
//   - maksimal 1 emoji, dan hanya di awal balasan
//   - tidak ada `undefined`, `NaN`, atau `[object`
//   - nominal selalu berformat Rp penuh

import { describe, expect, it } from 'vitest';
import * as t from '../../src/modules/whatsapp/whatsapp.templates.js';
import type { RejectReason } from '../../src/parsers/types.js';

const TODAY = '2026-09-28';

const food: t.TransactionView = {
  type: 'expense',
  amount: 25000,
  categoryName: 'Makanan',
  categorySlug: 'food',
  date: TODAY,
  description: 'makan siang',
};
const income: t.TransactionView = {
  type: 'income',
  amount: 5_000_000,
  categoryName: 'Gaji',
  categorySlug: 'salary',
  date: '2026-09-25',
  description: '',
};

const REASONS: RejectReason[] = [
  'amount_too_large',
  'amount_zero',
  'amount_negative',
  'date_future',
  'date_too_vague',
  'date_too_old',
  'date_invalid',
];

const samples: [string, string][] = [
  ['confirmation', t.confirmation(food, TODAY)],
  ['confirmation + asumsi ribuan', t.confirmation({ ...food, assumedThousands: true }, TODAY)],
  ['confirmation pemasukan tanpa catatan', t.confirmation(income, TODAY)],
  ['saved', t.saved(food, TODAY)],
  ['cancelled', t.cancelled()],
  ['nothingToCancel', t.nothingToCancel()],
  ['nothingToConfirm', t.nothingToConfirm()],
  ['askCategory', t.askCategory({ options: ['Belanja', 'Makanan', 'Tagihan'], amount: 100000 })],
  ['askCategory tanpa nominal', t.askCategory({ options: ['Gaji', 'Bonus', 'Freelance'] })],
  ['askCategoryAgain', t.askCategoryAgain({ options: ['Belanja', 'Makanan', 'Tagihan'] }, t.CATEGORY_NOT_FOUND)],
  ['askAmount + kategori', t.askAmount({ description: 'bayar listrik', categoryName: 'Tagihan' })],
  ['askAmount tanpa kategori', t.askAmount({ description: 'tadi beli sesuatu' })],
  ['askAmount kosong', t.askAmount({ description: '' })],
  ['askAmountAgain', t.askAmountAgain()],
  ['askAmountAmbiguous', t.askAmountAmbiguous(5)],
  ['confirmationStillWaiting', t.confirmationStillWaiting()],
  ['confirmDelete', t.confirmDelete(food, TODAY)],
  ['deleted', t.deleted(food)],
  ['nothingToDelete', t.nothingToDelete()],
  ['alreadyDeleted', t.alreadyDeleted()],
  ['help', t.help()],
  ['unknownMessage', t.unknownMessage()],
  ['queryUnavailable', t.queryUnavailable()],
  ['correctUnavailable', t.correctUnavailable()],
  ['unsupportedMedia', t.unsupportedMedia()],
  ['inviteToRegister', t.inviteToRegister()],
  ['noAccount', t.noAccount()],
  ['categoryGone', t.categoryGone()],
  ...REASONS.map((reason): [string, string] => [`rejection ${reason}`, t.rejection(reason)]),
];

// Satu emoji = satu grafem yang memuat piktograf; "•" dan "·" bukan emoji.
const segmenter = new Intl.Segmenter('id', { granularity: 'grapheme' });
const emojiGraphemes = (text: string): { index: number }[] =>
  [...segmenter.segment(text)].filter((part) => /\p{Extended_Pictographic}/u.test(part.segment));

describe('template balasan WhatsApp', () => {
  it.each(samples)('%s: maksimal lima baris, tidak kosong', (_name, text) => {
    expect(text.trim()).not.toBe('');
    expect(text.split('\n').length).toBeLessThanOrEqual(5);
  });

  it.each(samples)('%s: maksimal satu emoji dan hanya di awal', (_name, text) => {
    const found = emojiGraphemes(text);
    expect(found.length).toBeLessThanOrEqual(1);
    if (found.length === 1) expect(found[0]?.index).toBe(0);
  });

  it.each(samples)('%s: tidak ada nilai kosong yang bocor', (_name, text) => {
    expect(text).not.toMatch(/undefined|NaN|\[object|null/);
  });

  it('semua kategori sistem punya penanda emoji, dan kategori lain jatuh ke emoji umum', () => {
    const slugs = [
      'food',
      'transport',
      'shopping',
      'bills',
      'health',
      'entertainment',
      'other_expense',
      'salary',
      'bonus',
      'freelance',
      'investment',
      'other_income',
    ];
    for (const slug of slugs) expect(t.categoryEmoji(slug)).not.toBe('📝');
    expect(t.categoryEmoji('kategori_buatan_sendiri')).toBe('📝');
  });

  it('konfirmasi memuat nominal Rp penuh, tanggal, dan instruksi YA/BATAL', () => {
    const text = t.confirmation(food, TODAY);
    expect(text).toContain('Rp25.000');
    expect(text).toContain('Hari ini, 28 Sep');
    expect(text).toContain('Makanan');
    expect(text).toContain('"makan siang"');
    expect(text).toMatch(/YA.*BATAL/);
  });

  it('asumsi ribuan tampil di konfirmasi', () => {
    expect(t.confirmation({ ...food, assumedThousands: true }, TODAY)).toMatch(/ribuan/);
    expect(t.confirmation(food, TODAY)).not.toMatch(/ribuan/);
  });

  it('pertanyaan kategori memberi nomor 1..3 dan menyebut nominal', () => {
    const text = t.askCategory({ options: ['Belanja', 'Makanan', 'Tagihan'], amount: 100000 });
    expect(text).toContain('Rp100.000');
    expect(text).toMatch(/^1\. Belanja$/m);
    expect(text).toMatch(/^2\. Makanan$/m);
    expect(text).toMatch(/^3\. Tagihan$/m);
  });

  it('pertanyaan nominal menyebut kategori yang sudah terdeteksi', () => {
    expect(t.askAmount({ description: 'bayar listrik', categoryName: 'Tagihan' })).toBe(
      '"bayar listrik" masuk Tagihan.\nBerapa nominalnya?',
    );
  });

  it('tanggal: hari ini, kemarin, tanggal lain, dan tahun lain', () => {
    expect(t.dateLabel('2026-09-28', TODAY)).toBe('Hari ini, 28 Sep');
    expect(t.dateLabel('2026-09-27', TODAY)).toBe('Kemarin, 27 Sep');
    expect(t.dateLabel('2026-09-01', TODAY)).toBe('1 Sep');
    expect(t.dateLabel('2025-12-31', TODAY)).toBe('31 Des 2025');
    expect(t.dateLabel('2026-02-28', '2026-03-01')).toBe('Kemarin, 28 Feb');
  });

  it('kutipan pesan pengguna dirapikan menjadi satu baris dan dipotong, supaya balasan tetap pendek', () => {
    const long = `makan\nsiang ${'x'.repeat(200)}`;
    const text = t.confirmation({ ...food, description: long }, TODAY);
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(200);
  });
});
