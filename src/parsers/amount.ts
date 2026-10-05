// Tahap 3: ekstraksi nominal. REGEX SAJA, bagian paling kritis di seluruh sistem: salah di sini
// berarti kerugian finansial langsung bagi pengguna. Prinsipnya: nominal tidak jelas atau tidak
// ada -> hasil `missing`/`ambiguous` (pipeline bertanya), tidak pernah menebak.
//
// Semua hitungan memakai bilangan bulat (aturan 1); desimal seperti "1,5jt" dihitung dengan
// aritmetika bilangan bulat, bukan Float yang dibulatkan belakangan.

import { MAX_TRANSACTION_AMOUNT } from '../shared/constants/limits.js';
import type { AmountResult, TransactionType } from './types.js';

const THOUSAND = 1_000;
const MILLION = 1_000_000;

// Satu kandidat: [-] [rp[.]] angka dengan pemisah [sufiks]. Angka yang menempel pada huruf lain
// ("15ewu", "2kg") bukan kandidat. "m" hanya sebagai sufiks juta bila menempel ("1.5m").
// Tanda "-" hanya negatif di awal pesan atau setelah spasi, dan menempel pada angka: "kopi-18rb"
// dan "kopi - 18rb" memakai tanda hubung sebagai pemisah.
const CANDIDATE = new RegExp(
  '(?:(?<=^|\\s)(?<neg>-))?' +
    '(?<![\\p{L}\\p{N}])' +
    '(?<rp>rp\\.?\\s*)?' +
    '(?<num>\\d+(?:[.,]\\d+)*)' +
    '(?:\\s*(?<suffix>juta|jt|ribu|rb|k)|(?<mega>m))?' +
    '(?![\\p{L}\\p{N}])',
  'gu',
);

interface Candidate {
  start: number;
  end: number;
  negative: boolean;
  value: number;
  /** 1: sufiks atau "rp"; 2: berpemisah atau >= 1.000; 3: angka telanjang di bawah 1.000. */
  tier: 1 | 2 | 3;
}

function multiplierOf(suffix: string | undefined, mega: string | undefined): number {
  if (mega !== undefined) return MILLION;
  if (suffix === undefined) return 1;
  return suffix === 'juta' || suffix === 'jt' ? MILLION : THOUSAND;
}

/** Nilai rupiah bulat dari angka berpemisah, atau null bila bentuknya tidak bisa dipastikan. */
function valueOf(num: string, multiplier: number): number | null {
  const parts = num.split(/[.,]/);
  const [first = '', ...rest] = parts;

  if (rest.length === 0) return Number(first) * multiplier;

  const grouped = first.length <= 3 && first !== '0' && rest.every((part) => part.length === 3);
  if (grouped) return Number(parts.join('')) * multiplier;

  // Desimal ("1,5jt", "25.5 ribu") hanya sah dengan sufiks; "25.5" polos dibiarkan tak terbaca.
  if (multiplier === 1 || rest.length !== 1) return null;
  const fraction = rest[0] as string;
  return Number(first) * multiplier + Math.round((Number(fraction) * multiplier) / 10 ** fraction.length);
}

function candidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const groups = match.groups as Record<string, string | undefined>;
    const multiplier = multiplierOf(groups.suffix, groups.mega);
    const value = valueOf(groups.num as string, multiplier);
    if (value === null) continue;

    const explicit = multiplier > 1 || groups.rp !== undefined;
    const tier = explicit ? 1 : (groups.num as string).search(/[.,]/) >= 0 || value >= THOUSAND ? 2 : 3;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      negative: groups.neg !== undefined,
      value,
      tier,
    });
  }
  return found;
}

export interface AmountMatch {
  result: AmountResult;
  /** Posisi potongan teks sumber nominal; -1 bila tidak ada. */
  start: number;
  end: number;
}

const NONE: AmountMatch = { result: { status: 'missing' }, start: -1, end: -1 };

/** Seperti `extractAmount`, tetapi mengembalikan juga posisi potongan teksnya. */
export function findAmount(text: string, type: TransactionType): AmountMatch {
  const all = candidates(text);
  if (all.length === 0) return NONE;

  // Penanda eksplisit (sufiks, "rp") mengalahkan angka berpemisah, yang mengalahkan angka
  // telanjang: "beli 3 kopi 54 ribu" -> 54.000, angka 3 diabaikan.
  const bestTier = Math.min(...all.map((candidate) => candidate.tier));
  const best = all.filter((candidate) => candidate.tier === bestTier);
  const chosen = best[0] as Candidate;

  // Dua nominal berbeda pada tingkat yang sama: tidak ada dasar memilih satu, jadi bertanya.
  if (best.some((candidate) => candidate.value !== chosen.value || candidate.negative !== chosen.negative)) {
    return NONE;
  }

  const matched = text.slice(chosen.start, chosen.end);
  const at = { start: chosen.start, end: chosen.end };

  if (chosen.negative) return { result: { status: 'rejected', reason: 'negative', matched }, ...at };
  if (chosen.value === 0) return { result: { status: 'rejected', reason: 'zero', matched }, ...at };
  if (chosen.value > MAX_TRANSACTION_AMOUNT) {
    return { result: { status: 'rejected', reason: 'too_large', matched }, ...at };
  }

  if (chosen.tier === 3) {
    // Angka telanjang di bawah 1.000. Pengeluaran Rp20 tidak ada dalam praktik, jadi dibaca
    // ribuan dan ditandai agar tampak di konfirmasi. Pemasukan terlalu lebar rentangnya: tanya.
    if (type === 'income') {
      return { result: { status: 'ambiguous', reason: 'bare_income', value: chosen.value, matched }, ...at };
    }
    return {
      result: { status: 'found', amount: chosen.value * THOUSAND, assumedThousands: true, matched },
      ...at,
    };
  }

  return { result: { status: 'found', amount: chosen.value, assumedThousands: false, matched }, ...at };
}

export function extractAmount(text: string, type: TransactionType): AmountResult {
  return findAmount(text, type).result;
}
