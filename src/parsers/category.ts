// Tahap 5: tipe transaksi dan kategori, kamus dulu. Bila kamus tidak mengenali pesan, hasilnya
// `unknown` dan pipeline bertanya ke pengguna; tidak ada tebakan di sini.

import { buildTerms, containsWholeWord, INCOME_MARKERS, wholeWord } from './keywords.js';
import type { CategoryDictionary, CategoryResult, TransactionType } from './types.js';

export function classifyType(text: string): TransactionType {
  return INCOME_MARKERS.some((marker) => containsWholeWord(text, marker)) ? 'income' : 'expense';
}

export interface CategoryMatch {
  slug: string;
  keyword: string;
  /** Posisi kata kunci di `text`, untuk membuangnya dari catatan command. */
  start: number;
  end: number;
}

interface Candidate extends CategoryMatch {
  generic: boolean;
  order: number;
}

function better(a: Candidate, b: Candidate): boolean {
  // Yang muncul paling awal menang; seri -> istilah lebih panjang; seri -> urutan kamus.
  if (a.start !== b.start) return a.start < b.start;
  if (a.keyword.length !== b.keyword.length) return a.keyword.length > b.keyword.length;
  return a.order < b.order;
}

/** Seperti `classifyCategory`, tetapi mengembalikan juga posisi kata kunci yang cocok. */
export function findCategory(text: string, dictionary: CategoryDictionary): CategoryMatch | null {
  let bestSpecific: Candidate | null = null;
  let bestGeneric: Candidate | null = null;

  for (const [order, { term, generic, entry }] of buildTerms(dictionary).entries()) {
    const found = wholeWord(term).exec(text);
    if (!found) continue;
    const candidate: Candidate = {
      slug: entry.slug,
      keyword: term,
      start: found.index,
      end: found.index + term.length,
      generic,
      order,
    };
    if (generic) {
      if (!bestGeneric || better(candidate, bestGeneric)) bestGeneric = candidate;
    } else if (!bestSpecific || better(candidate, bestSpecific)) {
      bestSpecific = candidate;
    }
  }

  const winner = bestSpecific ?? bestGeneric;
  return winner ? { slug: winner.slug, keyword: winner.keyword, start: winner.start, end: winner.end } : null;
}

export function classifyCategory(text: string, dictionary: CategoryDictionary): CategoryResult {
  const match = findCategory(text, dictionary);
  return match ? { status: 'matched', slug: match.slug, keyword: match.keyword } : { status: 'unknown' };
}
