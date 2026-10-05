/// <reference types="vite/client" />

// Alat bersama test parser (P13). Parsernya sendiri belum ada; test ditulis lebih dulu dan memuat
// modulnya lewat `import.meta.glob`, bukan impor statis. Dua alasannya:
//  - `npm run typecheck` tetap hijau tanpa berkas stub di src/parsers/;
//  - setiap kasus gagal sendiri dengan pesan yang jelas ("Parser belum diimplementasikan"), bukan
//    satu kegagalan impor per berkas yang menyembunyikan jumlah kasus. Angka "N gagal" itulah
//    penunjuk kemajuan P14.
// Begitu src/parsers/*.ts ada, pemuat ini langsung memakainya; tidak ada yang perlu diubah.

import { SYSTEM_CATEGORIES } from '../../../prisma/seed-data.js';
import type {
  AmountModule,
  AwaitingState,
  CategoryDictionary,
  CategoryModule,
  DateModule,
  IntentClassification,
  IntentModule,
  NormalizeModule,
  ParseContext,
  ParseResult,
  ParserModule,
} from '../../../src/parsers/types.js';

const loaders = import.meta.glob('../../../src/parsers/*.ts');

async function load<T>(file: string): Promise<T> {
  const loader = loaders[`../../../src/parsers/${file}.ts`];
  if (!loader) {
    throw new Error(`Parser belum diimplementasikan: src/parsers/${file}.ts belum ada (diharapkan, tugas P14)`);
  }
  return (await loader()) as T;
}

/** Pintu tunggal ke parser. Setiap panggilan memuat modulnya, jadi galat "belum ada" muncul per kasus. */
export const parser = {
  normalize: async (raw: string) => (await load<NormalizeModule>('normalize')).normalize(raw),

  /** Tahap 1 lalu tahap 2, seperti di pipeline. */
  intent: async (raw: string, options?: { awaiting?: AwaitingState }): Promise<IntentClassification> => {
    const { normalize } = await load<NormalizeModule>('normalize');
    const { classifyIntent } = await load<IntentModule>('intent');
    return classifyIntent(normalize(raw), options);
  },

  extractAmount: async (text: string, type: 'income' | 'expense' = 'expense') =>
    (await load<AmountModule>('amount')).extractAmount(text, type),

  extractDate: async (text: string, now: Date = NOW) => (await load<DateModule>('date')).extractDate(text, now),

  classifyType: async (text: string) => (await load<CategoryModule>('category')).classifyType(text),

  classifyCategory: async (text: string, dictionary: CategoryDictionary = DICTIONARY) =>
    (await load<CategoryModule>('category')).classifyCategory(text, dictionary),

  parseMessage: async (raw: string, context: Partial<ParseContext> = {}): Promise<ParseResult> =>
    (await load<ParserModule>('index')).parseMessage(raw, ctx(context)),
};

// ---------------------------------------------------------------------------
// Waktu acuan
// ---------------------------------------------------------------------------

/** Jam WIB (UTC+7) pada tanggal tertentu: `wib('2026-09-30', 12, 30)` -> 2026-09-30 12:30 WIB. */
export function wib(date: string, hour = 12, minute = 0): Date {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return new Date(`${date}T${hh}:${mm}:00+07:00`);
}

/**
 * Rabu, 30 September 2026, 12.00 WIB. Hari Rabu dipilih agar "senin kemarin" (28 Sep) dan
 * "tanggal 25" (sudah lewat di bulan berjalan) tidak kebetulan jatuh di hari ini.
 */
export const NOW = wib('2026-09-30', 12, 0);
export const TODAY = '2026-09-30';
export const YESTERDAY = '2026-09-29';

// ---------------------------------------------------------------------------
// Kamus
// ---------------------------------------------------------------------------

/**
 * Kamus kata kunci SEBENARNYA dari seed (prisma/seed-data.ts), bukan salinan khusus test. Kasus
 * yang butuh varian di luar seed (mkn, lunch, coffee) baru hijau setelah P14 memperluas kata kunci
 * di seed; itu disengaja, karena Bagian 17 menyatakan "kamus memuat varian umum".
 * Dibekukan: parser tidak boleh mengubah argumennya.
 */
export const DICTIONARY: CategoryDictionary = Object.freeze(
  SYSTEM_CATEGORIES.map(({ slug, name, type, keywords }) =>
    Object.freeze({ slug, name, type, keywords: Object.freeze([...keywords]) }),
  ),
);

export function ctx(overrides: Partial<ParseContext> = {}): ParseContext {
  return { now: NOW, categories: DICTIONARY, ...overrides };
}

/** Salinan hasil tanpa `original`, untuk membandingkan dua pesan yang hanya beda penulisan. */
export function withoutOriginal<T extends { original?: string }>(result: T): Omit<T, 'original'> {
  const { original: _original, ...rest } = result;
  void _original;
  return rest;
}
