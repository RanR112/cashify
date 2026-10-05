// Semua balasan WhatsApp ada di berkas ini (aturan 3): dirakit dari template dengan data dari
// database, tidak pernah dari teks yang dihasilkan LLM. Berkas ini sengaja dipisah dari logika
// percakapan supaya kalimatnya bisa diperbaiki tanpa menyentuh alurnya.
//
// Nada: Indonesia informal, tanpa basa-basi, maksimal LIMA baris per balasan, maksimal SATU emoji
// dan hanya di awal (penanda kategori). tests/unit/whatsapp-templates.test.ts menjaga ketiganya.
//
// Fungsi di sini murni: tanpa jaringan, tanpa database, tanpa jam sistem (tanggal "hari ini"
// datang sebagai argumen).

import type { RejectReason } from '../../parsers/types.js';
import { MAX_TRANSACTION_AMOUNT } from '../../shared/constants/limits.js';
import { formatRupiah } from '../../shared/utils/money.js';
import { addDays } from '../../shared/utils/timezone.js';

export const APP_NAME = 'Cashify';

/** Teks pesan pengguna yang ikut ditampilkan kembali (kutipan) dipotong sampai sepanjang ini. */
const MAX_QUOTE_LENGTH = 60;

type TransactionType = 'income' | 'expense';

// ---------------------------------------------------------------------------
// Pembantu format
// ---------------------------------------------------------------------------

/** Penanda kategori di awal balasan. Kategori buatan pengguna (slug tak dikenal) jatuh ke satu emoji umum. */
const CATEGORY_EMOJI: Readonly<Record<string, string>> = {
  food: '🍔',
  transport: '🚗',
  shopping: '🛍️',
  bills: '🧾',
  health: '💊',
  entertainment: '🎬',
  other_expense: '📦',
  salary: '💰',
  bonus: '🎁',
  freelance: '💻',
  investment: '📈',
  other_income: '💵',
};
const FALLBACK_EMOJI = '📝';

export function categoryEmoji(slug: string): string {
  return CATEGORY_EMOJI[slug] ?? FALLBACK_EMOJI;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'] as const;

/** "2026-09-28" -> "28 Sep"; tahun hanya ditulis bila bukan tahun `today`. */
function shortDate(date: string, today: string): string {
  const [year = '', month = '', day = ''] = date.split('-');
  const label = `${Number(day)} ${MONTHS[Number(month) - 1] ?? month}`;
  return year === today.slice(0, 4) ? label : `${label} ${year}`;
}

/** "Hari ini, 28 Sep", "Kemarin, 27 Sep", atau "25 Sep". */
export function dateLabel(date: string, today: string): string {
  if (date === today) return `Hari ini, ${shortDate(date, today)}`;
  if (date === addDays(today, -1)) return `Kemarin, ${shortDate(date, today)}`;
  return shortDate(date, today);
}

const typeLabel = (type: TransactionType): string => (type === 'income' ? 'Pemasukan' : 'Pengeluaran');

/** Satu baris, dipotong: pesan pengguna bisa panjang dan bisa berisi baris baru. */
function quote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_QUOTE_LENGTH ? `${flat.slice(0, MAX_QUOTE_LENGTH - 1)}…` : flat;
}

const lines = (...parts: (string | null | undefined | false)[]): string =>
  parts.filter((part): part is string => typeof part === 'string' && part !== '').join('\n');

// ---------------------------------------------------------------------------
// Konfirmasi dan hasil
// ---------------------------------------------------------------------------

export interface TransactionView {
  type: TransactionType;
  amount: number;
  categoryName: string;
  categorySlug: string;
  /** YYYY-MM-DD, Jakarta. */
  date: string;
  description: string;
  /** Angka telanjang dibaca ribuan; tampak di konfirmasi supaya salah tebak langsung terlihat. */
  assumedThousands?: boolean;
}

export function confirmation(view: TransactionView, today: string): string {
  return lines(
    `${categoryEmoji(view.categorySlug)} ${typeLabel(view.type)} · ${view.categoryName}`,
    `${formatRupiah(view.amount)} · ${dateLabel(view.date, today)}`,
    view.description !== '' && `"${quote(view.description)}"`,
    view.assumedThousands && 'Angka itu saya baca sebagai ribuan.',
    'Balas YA untuk simpan, BATAL untuk buang.',
  );
}

export function saved(view: TransactionView, today: string): string {
  return lines(
    `${categoryEmoji(view.categorySlug)} Tersimpan: ${typeLabel(view.type)} ${formatRupiah(view.amount)}`,
    `${view.categoryName} · ${dateLabel(view.date, today)}`,
  );
}

export const cancelled = (): string => 'Oke, dibatalkan.';
export const nothingToCancel = (): string => 'Tidak ada yang perlu dibatalkan.';
export const nothingToConfirm = (): string =>
  lines('Tidak ada transaksi yang menunggu konfirmasi.', 'Kalau sudah lewat 15 menit, kirim ulang ya.');

// ---------------------------------------------------------------------------
// Klarifikasi
// ---------------------------------------------------------------------------

export interface AskCategoryData {
  /** Nama kategori yang ditawarkan, sesuai nomornya. */
  options: readonly string[];
  /** Nominal bila sudah diketahui; menjadi pembuka pertanyaan. */
  amount?: number | undefined;
}

export function askCategory({ options, amount }: AskCategoryData): string {
  return lines(
    amount === undefined ? 'Kategorinya apa?' : `${formatRupiah(amount)} tercatat. Kategorinya apa?`,
    ...options.map((name, index) => `${index + 1}. ${name}`),
    'Balas nomornya, atau ketik nama kategori lain.',
  );
}

/** Jawaban tidak dikenali, atau "ya" datang sebelum kategorinya ada. Lebih pendek dari pertanyaan pertama. */
export function askCategoryAgain({ options }: Pick<AskCategoryData, 'options'>, headline: string): string {
  return lines(
    headline,
    ...options.map((name, index) => `${index + 1}. ${name}`),
    'Atau ketik nama kategori lain, atau BATAL.',
  );
}

export const CATEGORY_NOT_FOUND = 'Belum ketemu kategorinya. Pilih salah satu:';
export const CATEGORY_FIRST = 'Pilih kategorinya dulu ya:';

export interface AskAmountData {
  description: string;
  /** Nama kategori bila sudah terdeteksi dari pesan (mis. "bayar listrik" -> Tagihan). */
  categoryName?: string | undefined;
}

export function askAmount({ description, categoryName }: AskAmountData): string {
  const what = description === '' ? null : `"${quote(description)}"`;
  if (what && categoryName) return lines(`${what} masuk ${categoryName}.`, 'Berapa nominalnya?');
  if (what) return lines(`Catat ${what}.`, 'Berapa nominalnya? (contoh: 25 ribu)');
  return 'Berapa nominalnya? (contoh: 25 ribu)';
}

export const askAmountAgain = (): string =>
  lines('Nominalnya belum terbaca.', 'Tulis seperti 25 ribu atau 25000, atau BATAL.');

/** Pemasukan angka kecil tanpa sufiks: Rp5 atau Rp5.000.000? Tidak ditebak. */
export const askAmountAmbiguous = (value: number): string =>
  lines(`Angka ${value} itu ${value} ribu atau ${value} juta?`, `Tulis lengkap, mis. ${value} juta atau ${value} ribu.`);

export const confirmationStillWaiting = (): string => 'Masih ada transaksi yang menunggu. Balas YA untuk simpan, BATAL untuk buang.';

// ---------------------------------------------------------------------------
// Penolakan
// ---------------------------------------------------------------------------

export function rejection(reason: RejectReason): string {
  switch (reason) {
    case 'amount_too_large':
      return `Nominalnya terlalu besar (maksimal ${formatRupiah(MAX_TRANSACTION_AMOUNT)}). Cek lagi ya.`;
    case 'amount_zero':
      return 'Nominal tidak boleh nol. Tulis nominal yang benar, mis. 25 ribu.';
    case 'amount_negative':
      return 'Nominal tidak boleh negatif. Tulis tanpa tanda minus, mis. 25 ribu.';
    case 'date_future':
      return lines('Tanggalnya di masa depan.', 'Yang bisa dicatat hanya transaksi yang sudah terjadi.');
    case 'date_too_vague':
      return lines('Tanggalnya terlalu kabur.', 'Tulis yang spesifik, mis. "tanggal 25" atau "3 hari lalu".');
    case 'date_too_old':
      return lines('Tanggalnya lebih dari setahun lalu.', `Untuk transaksi selama itu, catat lewat aplikasi ${APP_NAME}.`);
    case 'date_invalid':
      return 'Tanggalnya tidak ada di kalender. Cek lagi ya.';
  }
}

// ---------------------------------------------------------------------------
// Hapus transaksi terakhir
// ---------------------------------------------------------------------------

export function confirmDelete(view: TransactionView, today: string): string {
  return lines(
    `${categoryEmoji(view.categorySlug)} Hapus transaksi ini?`,
    `${typeLabel(view.type)} ${formatRupiah(view.amount)} · ${view.categoryName} · ${dateLabel(view.date, today)}`,
    view.description !== '' && `"${quote(view.description)}"`,
    'Balas YA untuk hapus, BATAL untuk batal.',
  );
}

export const deleted = (view: TransactionView): string =>
  `${categoryEmoji(view.categorySlug)} Dihapus: ${formatRupiah(view.amount)} · ${view.categoryName}.`;

export const nothingToDelete = (): string =>
  lines(
    'Tidak ada transaksi dari WhatsApp dalam 24 jam terakhir yang bisa dihapus.',
    `Transaksi lain, hapus lewat aplikasi ${APP_NAME}.`,
  );

export const alreadyDeleted = (): string => 'Transaksinya sudah tidak ada.';

// ---------------------------------------------------------------------------
// Bantuan, intent yang belum ada, jenis pesan
// ---------------------------------------------------------------------------

export const help = (): string =>
  lines(
    'Contoh yang bisa dicatat:',
    '• makan siang 25 ribu',
    '• gaji 5 juta',
    '• /keluar 25000 makanan makan siang',
    'Balas YA/BATAL untuk konfirmasi. Ketik "hapus transaksi terakhir" untuk menghapus.',
  );

export const unknownMessage = (): string =>
  lines('Belum paham maksudnya. Contoh yang bisa dicatat:', '• makan siang 25 ribu', '• gaji 5 juta', '• /help untuk daftar lengkap');

export const queryUnavailable = (): string =>
  `Cek saldo dan laporan belum tersedia lewat WhatsApp. Buka aplikasi ${APP_NAME} ya.`;

export const correctUnavailable = (): string =>
  lines('Mengubah transaksi belum bisa lewat WhatsApp.', 'Ubah di aplikasi, atau hapus lalu catat ulang.');

export const unsupportedMedia = (): string =>
  lines('Gambar, suara, dan jenis pesan lain belum bisa dibaca.', 'Ketik saja, mis. "makan siang 25 ribu".');

export const inviteToRegister = (): string =>
  lines(
    `Nomor ini belum terhubung ke akun ${APP_NAME}.`,
    'Hubungkan di aplikasi (menu WhatsApp), lalu kirim pesan lagi.',
  );

// ---------------------------------------------------------------------------
// Galat yang bisa dijelaskan ke pengguna
// ---------------------------------------------------------------------------

export const noAccount = (): string =>
  lines('Belum ada akun untuk menyimpan transaksi.', `Buat dulu di aplikasi ${APP_NAME}, lalu kirim ulang.`);

export const categoryGone = (): string => 'Kategorinya sudah tidak ada. Kirim ulang transaksinya ya.';
