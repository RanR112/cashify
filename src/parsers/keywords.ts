// Kamus kata kunci dan pencocokan kata utuh. Kamusnya sendiri datang sebagai ARGUMEN
// (`categories.keywords` dari database); berkas ini hanya memuat konstanta parser dan alatnya.

import type { CategoryDictionary, CategoryEntry } from './types.js';

/** Penanda pemasukan (ARCHITECTURE.md Bagian 7 tahap 5). Selain ini, transaksi dianggap pengeluaran. */
export const INCOME_MARKERS: readonly string[] = [
  'gaji',
  'bonus',
  'thr',
  'dapat',
  'terima',
  'masuk',
  'untung',
  'dibayar',
  'fee',
  'komisi',
];

/**
 * Kata kunci kategori yang hampir selalu menyertai barang lain ("beli kopi", "beli bensin"), jadi
 * kalah dari kata kunci yang lebih spesifik dan baru menentukan kategori bila tidak ada pesaing.
 */
export const GENERIC_KEYWORDS: ReadonlySet<string> = new Set(['beli']);

const WORD_CHAR = '[\\p{L}\\p{N}]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pola "kata utuh": `ayam` tidak cocok di dalam `bayam`, `fee` tidak cocok di dalam `coffee`. */
export function wholeWord(term: string, flags = 'u'): RegExp {
  return new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(term)}(?!${WORD_CHAR})`, flags);
}

export function containsWholeWord(text: string, term: string): boolean {
  return wholeWord(term).test(text);
}

export interface Term {
  /** Kata kunci atau nama kategori, huruf kecil. */
  term: string;
  generic: boolean;
  entry: CategoryEntry;
}

/** Semua istilah yang dikenali sebuah kategori: kata kuncinya dan namanya ("makanan"). */
export function buildTerms(dictionary: CategoryDictionary): Term[] {
  const terms: Term[] = [];
  for (const entry of dictionary) {
    const seen = new Set<string>();
    for (const raw of [...entry.keywords, entry.name]) {
      const term = raw.trim().toLowerCase();
      if (term === '' || seen.has(term)) continue;
      seen.add(term);
      terms.push({ term, generic: GENERIC_KEYWORDS.has(term), entry });
    }
  }
  return terms;
}
