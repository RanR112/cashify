// Orkestrator pipeline (ARCHITECTURE.md Bagian 6 dan 7): pesan mentah -> hasil. Fungsi murni:
// tanpa jaringan, tanpa database, tanpa jam sistem. Kamus kata kunci dan `now` datang lewat
// `context`.
//
// Urutan keputusan untuk pesan transaksi (nominal dan tanggal selalu regex):
//   nominal ditolak > tanggal ditolak > bukan transaksi sama sekali (UNKNOWN)
//   > nominal kurang -> tanya nominal > kategori kabur -> tanya kategori > siap dikonfirmasi.
// Tidak ada nominal berarti bertanya; tidak ada tebakan dan tidak ada default.

import { findAmount } from './amount.js';
import { classifyType, findCategory } from './category.js';
import { findDate } from './date.js';
import { classifyIntent } from './intent.js';
import { normalize } from './normalize.js';
import { toJakartaDate } from '../shared/utils/timezone.js';
import type {
  Assumption,
  ParseContext,
  ParseResult,
  RejectReason,
  TransactionType,
} from './types.js';
import { limitDescription, validateDraft } from './validate.js';

export { normalize } from './normalize.js';
export { classifyIntent } from './intent.js';
export { extractAmount } from './amount.js';
export { extractDate } from './date.js';
export { classifyCategory, classifyType } from './category.js';
export { validateDraft } from './validate.js';

/** Membuang potongan [start, end) dan menggantinya dengan spasi (start < 0: tidak ada yang dibuang). */
function cut(text: string, start: number, end: number): string {
  return start < 0 ? text : `${text.slice(0, start)} ${text.slice(end)}`;
}

function rejection(original: string, reason: RejectReason): ParseResult {
  return { outcome: 'rejected', original, intent: 'CREATE_TRANSACTION', reason };
}

interface TransactionInput {
  original: string;
  /** Teks ternormalisasi; untuk command, hanya argumennya (setelah "/keluar"). */
  text: string;
  type: TransactionType;
  isCommand: boolean;
}

function parseTransaction(input: TransactionInput, context: ParseContext): ParseResult {
  const { original, text, type, isCommand } = input;

  // Tanggal lebih dulu supaya angka penanda tanggal ("tanggal 25", "2 hari lalu") tidak terbaca
  // sebagai nominal.
  const date = findDate(text, context.now);
  const withoutDate = cut(text, date.start, date.end);
  const amount = findAmount(withoutDate, type);
  const remainder = cut(withoutDate, amount.start, amount.end);

  const dictionary = context.categories.filter((category) => category.type === type);
  const category = findCategory(remainder, dictionary);

  if (amount.result.status === 'rejected') return rejection(original, `amount_${amount.result.reason}`);
  if (date.result.status === 'rejected') {
    const reason = date.result.reason === 'invalid_date' ? 'date_invalid' : (`date_${date.result.reason}` as RejectReason);
    return rejection(original, reason);
  }

  const found = amount.result.status === 'found' ? amount.result : null;
  if (!isCommand && amount.result.status === 'missing' && !category && !/\d/.test(text)) {
    return { outcome: 'intent', original, intent: 'UNKNOWN' };
  }

  // Command: "<nominal> [kategori] [catatan]"; catatan adalah sisanya tanpa kata kategori.
  // Bahasa alami: catatan adalah pesan tanpa nominal dan penanda tanggal.
  const description = limitDescription(category && isCommand ? cut(remainder, category.start, category.end) : remainder);
  const day = date.result.date;
  const assumptions: Assumption[] = found?.assumedThousands ? ['amount_in_thousands'] : [];

  if (!found) {
    return {
      outcome: 'clarify',
      original,
      intent: 'CREATE_TRANSACTION',
      ask: 'amount',
      type,
      date: day,
      description,
      assumptions,
      ...(category ? { categorySlug: category.slug } : {}),
      ...(amount.result.status === 'ambiguous' ? { ambiguousAmount: amount.result.value } : {}),
    };
  }

  if (!category) {
    return {
      outcome: 'clarify',
      original,
      intent: 'CREATE_TRANSACTION',
      ask: 'category',
      type,
      date: day,
      description,
      assumptions,
      amount: found.amount,
    };
  }

  const checked = validateDraft({
    amount: found.amount,
    date: day,
    today: toJakartaDate(context.now),
  });
  if (!checked.ok) return rejection(original, checked.reason);

  return {
    outcome: 'ready',
    original,
    intent: 'CREATE_TRANSACTION',
    type,
    amount: found.amount,
    date: day,
    categorySlug: category.slug,
    description,
    assumptions,
  };
}

export function parseMessage(raw: string, context: ParseContext): ParseResult {
  const normalized = normalize(raw);
  const { original, text } = normalized;

  const classified = classifyIntent(normalized, { awaiting: context.awaiting });
  if (classified.intent === 'IGNORED') return { outcome: 'ignored', original };

  if (classified.via === 'command' && classified.intent === 'CREATE_TRANSACTION') {
    return parseTransaction(
      {
        original,
        text: text.replace(/^\/\S*\s*/, ''),
        type: classified.command === 'masuk' ? 'income' : 'expense',
        isCommand: true,
      },
      context,
    );
  }

  if (classified.via === 'fallthrough') {
    return parseTransaction({ original, text, type: classifyType(text), isCommand: false }, context);
  }

  if (classified.intent === 'CORRECT') {
    // Nominal baru hanya dibawa bila tertulis jelas; angka telanjang ("ubah jadi 20") dibiarkan
    // kosong supaya alur percakapan bertanya, bukan menebak ribuan untuk transaksi yang tipenya
    // hanya diketahui service.
    const found = findAmount(text, 'expense').result;
    return found.status === 'found' && !found.assumedThousands
      ? { outcome: 'intent', original, intent: 'CORRECT', amount: found.amount }
      : { outcome: 'intent', original, intent: 'CORRECT' };
  }

  return { outcome: 'intent', original, intent: classified.intent as Exclude<typeof classified.intent, 'CREATE_TRANSACTION'> };
}
