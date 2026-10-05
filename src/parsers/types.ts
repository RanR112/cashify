// Kontrak parser transaksi (ARCHITECTURE.md Bagian 6, 7, dan 17). Hanya tipe: berkas ini tidak
// mengimpor apa pun (aturan 9, parsers/ adalah fungsi murni), dan menjadi daftar tugas P14.
//
// Semua fungsi murni dan sinkron: tanpa jaringan, tanpa database, tanpa jam sistem. Waktu masuk
// lewat `now`, kamus kata kunci lewat argumen. Nominal dan tanggal selalu dari regex, tidak pernah
// dari LLM (aturan 2); hasil di sini tidak punya jalur masuk bagi LLM untuk keduanya.
//
// Pembagian berkas (BACKEND-STRUCTURE.md Bagian 6) dan ekspor yang dijanjikan:
//   normalize.ts  -> normalize                      (tahap 1)
//   intent.ts     -> classifyIntent                 (tahap 2)
//   amount.ts     -> extractAmount                  (tahap 3)
//   date.ts       -> extractDate                    (tahap 4)
//   category.ts   -> classifyType, classifyCategory (tahap 5)
//   index.ts      -> parseMessage                   (orkestrator; tahap 6 ada di validate.ts)

// ---------------------------------------------------------------------------
// Dasar
// ---------------------------------------------------------------------------

/** Sembilan intent Bagian 6. Pesan kosong bukan intent; lihat `IGNORED`. */
export type Intent =
  | 'CREATE_TRANSACTION'
  | 'CONFIRM'
  | 'CANCEL'
  | 'CLARIFY_RESPONSE'
  | 'QUERY'
  | 'CORRECT'
  | 'DELETE'
  | 'HELP'
  | 'UNKNOWN';

export type TransactionType = 'income' | 'expense';

/** Pertanyaan yang sedang menunggu jawaban pengguna (state percakapan; parser hanya membacanya). */
export type AwaitingState = 'confirmation' | 'category' | 'amount';

/** Tanggal kalender Asia/Jakarta, format YYYY-MM-DD. */
export type CalendarDate = string;

// ---------------------------------------------------------------------------
// Tahap 1: normalisasi
// ---------------------------------------------------------------------------

export interface NormalizedText {
  /** Teks persis seperti diterima (termasuk emoji dan huruf besar). Ini yang ditampilkan kembali ke pengguna. */
  original: string;
  /** Untuk pencocokan: trim, huruf kecil, spasi/baris baru dirapikan jadi satu spasi, emoji dibuang. */
  text: string;
}

// ---------------------------------------------------------------------------
// Tahap 2: intent tingkat pertama (regex)
// ---------------------------------------------------------------------------

export type CommandName = 'keluar' | 'masuk' | 'hapus' | 'saldo' | 'help' | 'unknown';

export interface IntentClassification {
  /** `IGNORED`: pesan kosong, tidak dibalas (Bagian 17). */
  intent: Intent | 'IGNORED';
  /**
   * - `command`: diawali "/" (diparse murni dengan regex);
   * - `keyword`: dikenali dari kata/pola (ya, batal, bantuan, hapus transaksi terakhir, ...);
   * - `fallthrough`: tahap 2 tidak memutuskan; `intent` sementara `UNKNOWN` dan pipeline lanjut ke
   *   tahap 3. Jadi `UNKNOWN` hanya final bila `via` bukan `fallthrough`.
   */
  via: 'command' | 'keyword' | 'fallthrough';
  /** Hanya untuk `via: 'command'`. */
  command?: CommandName;
}

export interface IntentOptions {
  /** Pertanyaan yang sedang menunggu jawaban. Tanpa ini, "makanan" bukan jawaban atas apa pun. */
  awaiting?: AwaitingState;
}

// ---------------------------------------------------------------------------
// Tahap 3: nominal
// ---------------------------------------------------------------------------

export type AmountRejectReason = 'too_large' | 'zero' | 'negative';

export type AmountResult =
  | {
      status: 'found';
      /** Rupiah bulat. */
      amount: number;
      /** True bila angka telanjang di bawah 1.000 dibaca sebagai ribuan (pengeluaran saja); tampilkan di konfirmasi. */
      assumedThousands: boolean;
      /** Potongan teks yang menjadi sumber nominal, supaya tahap lain tidak membacanya lagi. */
      matched: string;
    }
  | {
      /** Pemasukan di bawah 1.000 tanpa sufiks: Rp5 atau Rp5.000.000? Sistem bertanya, tidak menebak. */
      status: 'ambiguous';
      reason: 'bare_income';
      value: number;
      matched: string;
    }
  | { status: 'missing' }
  | { status: 'rejected'; reason: AmountRejectReason; matched: string };

// ---------------------------------------------------------------------------
// Tahap 4: tanggal
// ---------------------------------------------------------------------------

export type DateRejectReason = 'future' | 'too_vague' | 'too_old' | 'invalid_date';

export type DateResult =
  | {
      status: 'found';
      date: CalendarDate;
      /** Potongan teks penanda tanggal ("kemarin", "tanggal 25"); string kosong bila tidak disebut (hari ini). */
      matched: string;
    }
  | { status: 'rejected'; reason: DateRejectReason; matched: string };

// ---------------------------------------------------------------------------
// Tahap 5: tipe dan kategori
// ---------------------------------------------------------------------------

/** Satu baris kamus; bentuknya mengikuti `categories` di database. Kamus selalu diberikan sebagai argumen. */
export interface CategoryEntry {
  slug: string;
  /** Nama tampilan ("Makanan"). Dipakai bila pengguna menyebut kategori dengan namanya, mis. di command. */
  name: string;
  type: TransactionType;
  /** Huruf kecil. Kategori cadangan ("Lainnya") berkeyword kosong dan tidak pernah cocok. */
  keywords: readonly string[];
}

export type CategoryDictionary = readonly CategoryEntry[];

export type CategoryResult = { status: 'matched'; slug: string; keyword: string } | { status: 'unknown' };

// ---------------------------------------------------------------------------
// Hasil akhir
// ---------------------------------------------------------------------------

export interface ParseContext {
  /** Instan sekarang. Tanggal selalu dihitung di Asia/Jakarta dari nilai ini; jam sistem tidak pernah dibaca. */
  now: Date;
  categories: CategoryDictionary;
  awaiting?: AwaitingState;
}

/** Hal yang ditebak sistem dan harus tampak di konfirmasi. */
export type Assumption = 'amount_in_thousands';

export type RejectReason =
  | 'amount_too_large'
  | 'amount_zero'
  | 'amount_negative'
  | 'date_future'
  | 'date_too_vague'
  | 'date_too_old'
  | 'date_invalid';

interface ResultBase {
  /** Teks asli pesan, tak diubah. */
  original: string;
}

/** Pesan kosong atau hanya spasi/emoji: tidak dibalas. */
export interface IgnoredResult extends ResultBase {
  outcome: 'ignored';
}

/** Intent selain membuat transaksi. `amount` hanya untuk `CORRECT` ("ubah jadi 35 ribu"). */
export interface IntentResult extends ResultBase {
  outcome: 'intent';
  intent: Exclude<Intent, 'CREATE_TRANSACTION'>;
  amount?: number;
}

/** Semua yang dibutuhkan untuk menampilkan konfirmasi. */
export interface ReadyTransaction extends ResultBase {
  outcome: 'ready';
  intent: 'CREATE_TRANSACTION';
  type: TransactionType;
  amount: number;
  date: CalendarDate;
  categorySlug: string;
  /** Teks pesan tanpa nominal dan penanda tanggal. Maksimal MAX_DESCRIPTION_LENGTH (255) karakter. */
  description: string;
  assumptions: Assumption[];
}

/** Ada yang belum jelas: bertanya, tidak menebak (Bagian 17). Field yang sudah diketahui tetap dibawa. */
export interface ClarifyTransaction extends ResultBase {
  outcome: 'clarify';
  intent: 'CREATE_TRANSACTION';
  ask: 'amount' | 'category';
  type: TransactionType;
  date: CalendarDate;
  description: string;
  assumptions: Assumption[];
  /** Ada bila `ask` adalah `category`, atau bila nominal ada tetapi kategori kabur. */
  amount?: number;
  /** Ada bila kategori sudah terdeteksi (mis. "bayar listrik" -> bills) dan yang kurang nominal. */
  categorySlug?: string;
  /**
   * Ada bila nominal ada tetapi ambigu (pemasukan "gaji 5": Rp5 atau Rp5.000.000?). Balasan memakainya
   * untuk bertanya "5 ribu atau 5 juta?" alih-alih seolah-olah angkanya tidak ditulis. Bukan nominal.
   */
  ambiguousAmount?: number;
}

/** Ditolak dengan alasan; balasan menjelaskan dan, untuk tanggal, meminta tanggal spesifik. */
export interface RejectedTransaction extends ResultBase {
  outcome: 'rejected';
  intent: 'CREATE_TRANSACTION';
  reason: RejectReason;
}

export type ParseResult =
  | IgnoredResult
  | IntentResult
  | ReadyTransaction
  | ClarifyTransaction
  | RejectedTransaction;

// ---------------------------------------------------------------------------
// Antarmuka per berkas (dipakai test; P14 memenuhinya)
// ---------------------------------------------------------------------------

export interface NormalizeModule {
  normalize(raw: string): NormalizedText;
}

export interface IntentModule {
  classifyIntent(input: NormalizedText, options?: IntentOptions): IntentClassification;
}

export interface AmountModule {
  /** `type` menentukan perlakuan angka telanjang di bawah 1.000. */
  extractAmount(text: string, type: TransactionType): AmountResult;
}

export interface DateModule {
  /** `text` sudah dinormalisasi. */
  extractDate(text: string, now: Date): DateResult;
}

export interface CategoryModule {
  /** Penanda pemasukan Bagian 7 (gaji, bonus, thr, dapat, terima, masuk, untung, dibayar, fee, komisi); selain itu pengeluaran. */
  classifyType(text: string): TransactionType;
  classifyCategory(text: string, dictionary: CategoryDictionary): CategoryResult;
}

export interface ParserModule {
  parseMessage(raw: string, context: ParseContext): ParseResult;
}
