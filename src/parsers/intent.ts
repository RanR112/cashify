// Tahap 2: klasifikasi intent tingkat pertama, regex. Sekitar 40% pesan nyata berhenti di sini.
// Pesan yang tidak diputuskan tahap ini jatuh ke tahap 3 (`via: 'fallthrough'`, intent sementara
// UNKNOWN). Command ("/keluar ...") diparse murni dengan regex; tanpa "/" di awal bukan command.

import { findAmount } from './amount.js';
import type { CommandName, Intent, IntentClassification, IntentOptions, NormalizedText } from './types.js';

const CONFIRM = /^(?:ya|y|ok|iya|betul)$/;
const CANCEL = /^(?:batal|no|n|gajadi|salah)$/;
const DELETE = /^hapus(?: transaksi)?(?: terakhir)?$/;
const HELP = /^(?:bantuan|help|panduan|apa (?:aja|saja) yang bisa)\??$/;
const QUERY = [
  /^(?:berapa|brp) (?:total )?(?:pengeluaran|pemasukan|saldo|uang)\b[^\d]*$/,
  /^(?:total )?(?:pengeluaran|pemasukan|saldo)\b[^\d]*\bberapa\??$/,
  /^(?:cek )?saldo\??$/,
];
const CORRECT = /^(?:ubah|ganti|koreksi)\b(?: \w+)? (?:jadi|menjadi)\b/;

const CATEGORY_CHOICE = /^\d{1,2}$/;
const CATEGORY_NAME = /^\p{L}+(?: \p{L}+){0,2}$/u;

const COMMANDS: Record<string, { command: CommandName; intent: Intent }> = {
  keluar: { command: 'keluar', intent: 'CREATE_TRANSACTION' },
  masuk: { command: 'masuk', intent: 'CREATE_TRANSACTION' },
  hapus: { command: 'hapus', intent: 'DELETE' },
  saldo: { command: 'saldo', intent: 'QUERY' },
  help: { command: 'help', intent: 'HELP' },
  bantuan: { command: 'help', intent: 'HELP' },
};

/** Teks tanpa tanda baca di ujung: "ya!" dan "batal." tetap kata utuh. */
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?,\s]+$/, '');
}

function keyword(intent: Intent): IntentClassification {
  return { intent, via: 'keyword' };
}

export function classifyIntent(input: NormalizedText, options: IntentOptions = {}): IntentClassification {
  const { text } = input;
  if (text === '') return { intent: 'IGNORED', via: 'fallthrough' };

  if (text.startsWith('/')) {
    const name = /^\/(\S*)/.exec(text)?.[1] ?? '';
    const known = COMMANDS[name];
    return known
      ? { intent: known.intent, via: 'command', command: known.command }
      : { intent: 'UNKNOWN', via: 'command', command: 'unknown' };
  }

  const bare = stripTrailingPunctuation(text);
  if (CONFIRM.test(bare)) return keyword('CONFIRM');
  // Pembatalan diperiksa sebelum jawaban klarifikasi: "batal" selalu membatalkan.
  if (CANCEL.test(bare)) return keyword('CANCEL');
  if (DELETE.test(bare)) return keyword('DELETE');
  if (HELP.test(text)) return keyword('HELP');
  if (QUERY.some((pattern) => pattern.test(text))) return keyword('QUERY');
  if (CORRECT.test(text)) return keyword('CORRECT');

  if (isClarifyAnswer(bare, options.awaiting)) return keyword('CLARIFY_RESPONSE');

  return { intent: 'UNKNOWN', via: 'fallthrough' };
}

/**
 * Jawaban atas pertanyaan yang menunggu. Tanpa kamus di sini, bentuknya yang dinilai: jawaban
 * kategori itu pendek dan tanpa angka (atau satu nomor pilihan); jawaban nominal itu seluruh
 * pesan adalah satu nominal. Transaksi baru yang lengkap bukan jawaban dan menggantikan pending.
 */
function isClarifyAnswer(bare: string, awaiting: IntentOptions['awaiting']): boolean {
  if (awaiting === 'category') return CATEGORY_CHOICE.test(bare) || CATEGORY_NAME.test(bare);
  if (awaiting === 'amount') {
    const found = findAmount(bare, 'expense');
    return found.start === 0 && found.end === bare.length;
  }
  return false;
}
