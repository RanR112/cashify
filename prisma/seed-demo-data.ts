// Data murni untuk seed pengguna demo. Tidak mengimpor Prisma supaya bisa diuji unit.
//
// Tanggal dihitung relatif terhadap `today` (Jakarta), jadi data selalu terlihat segar.
// Jendela: tanggal 1 dua bulan sebelum bulan ini sampai hari ini, yaitu tiga bucket
// bulan kalender (dua bulan penuh + bulan berjalan sampai hari ini). Tidak pernah ada
// tanggal di masa depan.
//
// Acak memakai PRNG berbenih tetap: tanggal acuan yang sama selalu menghasilkan data yang
// sama, sehingga hasil seed bisa dibandingkan antar-jalan dan diuji.
//
// Pola (bukan angka acak datar):
//  - Gaji Rp7.000.000 setiap tanggal 1, jadi awal bulan berjalan tidak tampak minus.
//  - Makanan hampir tiap hari, akhir pekan lebih besar; transportasi 3-4 hari/minggu.
//  - Listrik (bervariasi) tanggal 5, internet tetap tanggal 10, Spotify tanggal 15.
//  - Belanja lebih sering di minggu gajian; satu pembelian besar di bulan tengah.
//  - Total pengeluaran sekitar Rp4-5 juta/bulan terhadap pemasukan Rp7 juta.

import {
  BUDGET_ALERT_TITLE,
  budgetAlert,
  DAILY_SUMMARY_TITLE,
  dailySummary,
} from '../src/modules/notifications/notifications.templates.js';
import {
  addDays,
  isValidDateString,
  jakartaDayStartUtc,
  monthBounds,
} from '../src/shared/utils/timezone.js';

export const DEMO_EMAIL = 'demo@cashify.test';
export const DEMO_PASSWORD = 'Demo-Cashify-2026';
export const DEMO_FULL_NAME = 'Demo Cashify';
export const DEMO_INITIAL_BALANCE = 2_000_000;

/** Nomor dan sesi palsu; tidak ada hubungannya dengan sesi OpenWA sungguhan. */
export const DEMO_WA_SESSION_ID = 'demo';
export const DEMO_WA_CHAT_ID = '6281200000000@c.us';

export const DEMO_SALARY_DAY = 1;
export const DEMO_SALARY_AMOUNT = 7_000_000;

export const DEMO_ACCOUNTS = [
  { name: 'Tunai', type: 'cash' },
  { name: 'BCA', type: 'bank' },
] as const;
export type DemoAccountName = (typeof DEMO_ACCOUNTS)[number]['name'];

export interface DemoTransactionSpec {
  /** Tanggal kalender Jakarta, YYYY-MM-DD. */
  date: string;
  /** Menit sejak tengah malam Jakarta; dipakai hanya bila `whatsapp` (transaksi manual tersimpan di awal hari). */
  minuteOfDay: number;
  type: 'income' | 'expense';
  categorySlug: string;
  account: DemoAccountName;
  amount: number;
  description: string;
  source: 'manual' | 'whatsapp';
  /** Isi pesan WhatsApp yang menghasilkan transaksi ini; null untuk transaksi manual. */
  whatsappBody: string | null;
  /** Nomor urut pesan WhatsApp (1-based), untuk wa_message_id yang deterministik. */
  whatsappSeq: number | null;
  /** Soft delete: kapan dihapus (instan UTC), atau null. */
  deletedAt: Date | null;
}

export interface DemoDataset {
  startDate: string;
  endDate: string;
  transactions: DemoTransactionSpec[];
}

// ---- PRNG dan pembantu ----

/** mulberry32: kecil, cepat, deterministik. Cukup untuk data contoh (bukan kriptografi). */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const roundTo = (value: number, step: number): number => Math.round(value / step) * step;

function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Tanggal 1 dua bulan sebelum bulan `today`. */
export function demoWindowStart(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 2;
  return month >= 1 ? `${year}-${pad2(month)}-01` : `${year - 1}-${pad2(month + 12)}-01`;
}

/** Awalan bulan YYYY-MM dari ketiga bucket, terlama dulu. */
export function demoMonths(today: string): [string, string, string] {
  const start = demoWindowStart(today);
  const [y, m] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
  const next = (offset: number): string => {
    const index = m - 1 + offset;
    return `${y + Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
  };
  return [next(0), next(1), next(2)];
}

/** Nominal untuk pesan chat: "25 ribu", "25rb", atau "25k". Hanya kelipatan Rp1.000. */
export function formatAmountForChat(amount: number, style: 'ribu' | 'rb' | 'k'): string {
  const thousands = amount / 1000;
  if (!Number.isInteger(thousands)) throw new RangeError(`Bukan kelipatan Rp1.000: ${amount}`);
  return style === 'ribu' ? `${thousands} ribu` : `${thousands}${style}`;
}

const spread = <T>(items: readonly T[], count: number): T[] =>
  Array.from({ length: count }, (_, j) => items[Math.floor(((j + 0.5) * items.length) / count)] as T);

// ---- katalog deskripsi ----

interface Item {
  description: string;
  /** Cara pengguna menulisnya di chat (huruf kecil, memuat kata kunci kategori). */
  chat: string;
  account?: DemoAccountName;
}

const BREAKFAST: Item[] = [
  { description: 'Sarapan nasi uduk', chat: 'sarapan nasi uduk' },
  { description: 'Kopi susu', chat: 'kopi susu' },
  { description: 'Sarapan bubur ayam', chat: 'sarapan bubur ayam' },
  { description: 'Kopi dan roti', chat: 'kopi dan roti' },
];
const LUNCH: Item[] = [
  { description: 'Makan siang warteg', chat: 'makan siang warteg' },
  { description: 'Makan siang ayam geprek', chat: 'makan siang ayam geprek' },
  { description: 'Makan siang bakso', chat: 'makan siang bakso' },
  { description: 'Makan siang nasi padang', chat: 'makan siang nasi padang' },
  { description: 'GoFood makan siang', chat: 'gofood makan siang', account: 'BCA' },
];
const DINNER: Item[] = [
  { description: 'Makan malam nasi goreng', chat: 'makan malam nasi goreng' },
  { description: 'Makan malam ayam bakar', chat: 'makan malam ayam bakar' },
  { description: 'Makan malam mie ayam', chat: 'makan malam mie ayam' },
  { description: 'Makan malam sate', chat: 'makan malam sate' },
  { description: 'GrabFood makan malam', chat: 'grabfood makan malam', account: 'BCA' },
];
const RIDES: Item[] = [
  { description: 'Grab ke kantor', chat: 'grab ke kantor', account: 'BCA' },
  { description: 'Ojek online pulang', chat: 'ojek pulang', account: 'BCA' },
  { description: 'Parkir motor', chat: 'parkir motor' },
];
const SHOPPING: Item[] = [
  { description: 'Belanja bulanan supermarket', chat: 'belanja bulanan' },
  { description: 'Beli baju di Shopee', chat: 'beli baju shopee' },
  { description: 'Beli perlengkapan rumah', chat: 'beli perlengkapan rumah' },
  { description: 'Belanja skincare', chat: 'belanja skincare' },
  { description: 'Beli buku di Tokopedia', chat: 'beli buku tokopedia' },
];
const LEISURE: Item[] = [
  { description: 'Nonton bioskop', chat: 'nonton bioskop', account: 'Tunai' },
  { description: 'Top up game', chat: 'top up game', account: 'BCA' },
];

/** Dikelompokkan supaya penyusun WhatsApp tahu mana yang layak jadi pesan chat. */
type Kind = 'food' | 'transport' | 'other';

interface Draft extends Omit<DemoTransactionSpec, 'whatsappSeq'> {
  kind: Kind;
  chat: string;
}

export function buildDemoDataset(today: string): DemoDataset {
  if (!isValidDateString(today)) throw new RangeError(`Bukan tanggal YYYY-MM-DD yang sah: ${today}`);

  const startDate = demoWindowStart(today);
  const [month0, month1] = demoMonths(today);
  const rng = createRng(20260101);
  const chance = (p: number): boolean => rng() < p;
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
  const rupiah = (lo: number, hi: number, step: number): number => roundTo(lo + rng() * (hi - lo), step);
  const minute = (fromHour: number, toHour: number): number => int(fromHour * 60, toHour * 60);

  const drafts: Draft[] = [];
  const add = (draft: Partial<Draft> & Pick<Draft, 'date' | 'categorySlug' | 'account' | 'amount' | 'description'>) => {
    drafts.push({
      minuteOfDay: 720,
      type: 'expense',
      source: 'manual',
      whatsappBody: null,
      deletedAt: null,
      kind: 'other',
      chat: draft.description.toLowerCase(),
      ...draft,
    });
  };
  const addFood = (date: string, item: Item, amount: number, minuteOfDay: number) =>
    add({
      date,
      categorySlug: 'food',
      account: item.account ?? 'Tunai',
      amount,
      description: item.description,
      minuteOfDay,
      kind: 'food',
      chat: item.chat,
    });

  let fuelCountdown = int(3, 8);

  for (let date = startDate; date <= today; date = addDays(date, 1)) {
    const dom = Number(date.slice(8, 10));
    const month = date.slice(0, 7);
    const weekend = dayOfWeek(date) === 0 || dayOfWeek(date) === 6;

    // Tagihan dan langganan tetap.
    if (dom === DEMO_SALARY_DAY) {
      add({
        date,
        type: 'income',
        categorySlug: 'salary',
        account: 'BCA',
        amount: DEMO_SALARY_AMOUNT,
        description: 'Gaji bulanan',
      });
    }
    if (dom === 5) {
      add({
        date,
        categorySlug: 'bills',
        account: 'BCA',
        amount: rupiah(380_000, 470_000, 1000),
        description: 'Tagihan listrik',
      });
    }
    if (dom === 10) {
      add({ date, categorySlug: 'bills', account: 'BCA', amount: 349_000, description: 'Internet bulanan' });
    }
    if (dom === 15) {
      add({ date, categorySlug: 'entertainment', account: 'BCA', amount: 55_000, description: 'Langganan Spotify' });
    }

    // Kejadian satu kali supaya antar-bulan tidak identik.
    if (month === month0 && dom === 14) {
      add({
        date,
        type: 'income',
        categorySlug: 'freelance',
        account: 'BCA',
        amount: 1_200_000,
        description: 'Fee desain logo klien',
      });
    }
    if (month === month1 && dom === 9) {
      add({
        date,
        type: 'income',
        categorySlug: 'freelance',
        account: 'BCA',
        amount: 900_000,
        description: 'Fee edit video',
      });
    }
    if (month === month0 && dom === 22) {
      add({ date, categorySlug: 'health', account: 'BCA', amount: 250_000, description: 'Dokter gigi' });
    }
    if (month === month1 && dom === 8) {
      add({ date, categorySlug: 'health', account: 'Tunai', amount: 85_000, description: 'Obat flu dan vitamin' });
    }
    if (month === month1 && dom === 20) {
      add({
        date,
        categorySlug: 'shopping',
        account: 'BCA',
        amount: 899_000,
        description: 'Sepatu lari di Tokopedia',
      });
    }

    // Makanan: sarapan, makan siang, makan malam. Akhir pekan lebih banyak makan di luar.
    let foodToday = 0;
    if (chance(weekend ? 0.2 : 0.3)) {
      addFood(date, pick(BREAKFAST), rupiah(15_000, 30_000, 1000), minute(6.5, 8.5));
      foodToday += 1;
    }
    if (chance(weekend ? 0.7 : 0.75)) {
      const amount = weekend ? rupiah(30_000, 55_000, 1000) : rupiah(25_000, 50_000, 1000);
      addFood(date, pick(LUNCH), amount, minute(11.75, 13.5));
      foodToday += 1;
    }
    if (chance(weekend ? 0.8 : 0.4)) {
      const amount = weekend ? rupiah(40_000, 75_000, 1000) : rupiah(30_000, 60_000, 1000);
      addFood(date, pick(DINNER), amount, minute(18.5, 20.75));
      foodToday += 1;
    }
    // "Hampir setiap hari": hari kosong jarang, bukan nol.
    if (foodToday === 0 && chance(0.7)) {
      addFood(date, pick(LUNCH), rupiah(25_000, 45_000, 1000), minute(11.75, 13.5));
    }

    // Transportasi: beberapa kali seminggu.
    if (chance(weekend ? 0.45 : 0.55)) {
      const ride = pick(RIDES);
      const amount = ride.description.startsWith('Parkir') ? rupiah(5_000, 12_000, 1000) : rupiah(15_000, 40_000, 1000);
      add({
        date,
        categorySlug: 'transport',
        account: ride.account ?? 'Tunai',
        amount,
        description: ride.description,
        minuteOfDay: chance(0.5) ? minute(7, 9) : minute(16.5, 18.5),
        kind: 'transport',
        chat: ride.chat,
      });
    }
    fuelCountdown -= 1;
    if (fuelCountdown <= 0) {
      add({
        date,
        categorySlug: 'transport',
        account: 'Tunai',
        amount: rupiah(50_000, 100_000, 5000),
        description: 'Bensin Pertalite',
        minuteOfDay: minute(7.5, 17),
        kind: 'transport',
        chat: 'bensin pertalite',
      });
      fuelCountdown = int(8, 11);
    }

    // Belanja: lebih sering di minggu gajian, nominal condong ke bawah.
    if (chance(dom <= 7 ? 0.14 : 0.06)) {
      const item = pick(SHOPPING);
      add({
        date,
        categorySlug: 'shopping',
        account: 'BCA',
        amount: roundTo(150_000 + rng() ** 2 * 450_000, 5000),
        description: item.description,
        chat: item.chat,
      });
    }

    // Hiburan acak.
    if (chance(0.08)) {
      const item = pick(LEISURE);
      const bioskop = item.description.startsWith('Nonton');
      add({
        date,
        categorySlug: 'entertainment',
        account: item.account ?? 'Tunai',
        amount: bioskop ? rupiah(50_000, 100_000, 5000) : rupiah(20_000, 100_000, 10_000),
        description: item.description,
        chat: item.chat,
      });
    }
  }

  // ---- transaksi WhatsApp: sebagian makanan/transportasi dijadikan pesan chat ----
  // Hari ini dikecualikan: jam pesan bisa lebih lambat dari jam seed dijalankan.
  const eligible = drafts.filter((d) => d.kind !== 'other' && d.date < today);
  const styles = ['ribu', 'rb', 'k'] as const;
  const messageFor = (draft: Draft, index: number): string => {
    const amount = formatAmountForChat(draft.amount, styles[index % styles.length] as (typeof styles)[number]);
    return `${index % 2 === 0 ? 'tadi ' : ''}${draft.chat} ${amount}`;
  };
  spread(eligible, 9).forEach((draft, index) => {
    draft.source = 'whatsapp';
    draft.whatsappBody = messageFor(draft, index);
  });

  // ---- transaksi yang sudah di-soft-delete ----
  // Semuanya di luar dua hari terakhir supaya `deletedAt` tidak melampaui waktu sekarang.
  const cutoff = addDays(today, -3);
  const deleteAfterHours = (hours: number, from: Pick<Draft, 'date' | 'minuteOfDay'>): Date =>
    new Date(jakartaDayStartUtc(from.date).getTime() + (from.minuteOfDay + hours * 60) * 60_000);

  const pastFood = drafts.filter((d) => d.kind === 'food' && d.source === 'manual' && d.date <= cutoff);
  const pastRide = drafts.filter((d) => d.kind === 'transport' && d.source === 'manual' && d.date <= cutoff);
  const duplicates = [...spread(pastFood, 2), ...spread(pastRide, 1)];
  const duplicateOffsets = [3, 5, 2];
  duplicates.forEach((original, index) => {
    // Ketuk dua kali: salinan persis yang kemudian dihapus pengguna.
    add({
      ...original,
      minuteOfDay: original.minuteOfDay + 1,
      deletedAt: deleteAfterHours(duplicateOffsets[index] ?? 2, original),
    });
  });

  add({
    date: `${month1}-12`,
    categorySlug: 'shopping',
    account: 'BCA',
    amount: 4_500_000, // salah ketik nol: seharusnya Rp450.000
    description: 'Beli headset',
    deletedAt: new Date(jakartaDayStartUtc(`${month1}-12`).getTime() + 22 * 3_600_000),
  });

  const wrongChat: Draft = {
    date: `${month1}-26`,
    minuteOfDay: 20 * 60 + 12,
    type: 'expense',
    categorySlug: 'food',
    account: 'Tunai',
    amount: 150_000, // salah ketik: seharusnya Rp50.000
    description: 'Makan malam',
    source: 'whatsapp',
    whatsappBody: 'makan malam 150 ribu',
    deletedAt: new Date(jakartaDayStartUtc(`${month1}-26`).getTime() + (20 * 60 + 14) * 60_000),
    kind: 'food',
    chat: 'makan malam',
  };
  drafts.push(wrongChat);

  // ---- urutkan dan beri nomor pesan WhatsApp ----
  drafts.sort((a, b) => a.date.localeCompare(b.date) || a.minuteOfDay - b.minuteOfDay);
  let seq = 0;
  const transactions = drafts.map((draft): DemoTransactionSpec => {
    const fromWhatsapp = draft.source === 'whatsapp';
    if (fromWhatsapp) seq += 1;
    return {
      date: draft.date,
      minuteOfDay: draft.minuteOfDay,
      type: draft.type,
      categorySlug: draft.categorySlug,
      account: draft.account,
      amount: draft.amount,
      description: draft.description,
      source: draft.source,
      whatsappBody: draft.whatsappBody,
      whatsappSeq: fromWhatsapp ? seq : null,
      deletedAt: draft.deletedAt,
    };
  });

  return { startDate, endDate: today, transactions };
}

// ---- anggaran dan riwayat notifikasi ----
//
// Keduanya dirakit dari data yang SUDAH ada di database (bukan dari dataset transaksi),
// supaya persentase anggaran benar-benar cocok dengan baris yang dilihat pengguna demo.
// Fungsi di bawah tetap murni: Prisma dan jam sistem tidak dikenal di sini.

export interface DemoCategorySpend {
  categoryId: string;
  name: string;
  slug: string;
  /** Total pengeluaran kategori dalam rentang, rupiah penuh. */
  total: number;
}

export interface DemoBudgetCategorySpec {
  categoryId: string;
  name: string;
  slug: string;
  amount: number;
  alertThreshold: number;
}

export interface DemoBudgetSpec {
  name: string;
  /** `YYYY-MM-DD`, tanggal 1 bulan berjalan. */
  periodStart: string;
  /** `YYYY-MM-DD`, akhir bulan berjalan. */
  periodEnd: string;
  totalAmount: number;
  autoRenew: boolean;
  rolloverEnabled: boolean;
  categories: DemoBudgetCategorySpec[];
  /** Kategori yang sengaja melewati ambang; null bila bulan ini belum ada pengeluaran. */
  alertCategoryId: string | null;
  /** Pengeluaran kategori alert bulan berjalan. */
  alertSpent: number;
}

const MONTH_NAMES = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
] as const;

const roundUpTo = (value: number, step: number): number => Math.ceil(value / step) * step;

const byTotalDesc = (a: DemoCategorySpend, b: DemoCategorySpend): number =>
  b.total - a.total || a.name.localeCompare(b.name);

/**
 * Anggaran bulan berjalan dengan 3-4 kategori pengeluaran.
 *
 * Kategori alert memakai alokasi `spend / 0.9`, jadi persentase terpakai 90-100% dan
 * statusnya `warning` (ambang 80). Kategori lain memakai `spend / 0.5` dengan lantai
 * Rp100.000, jadi statusnya `ok`. Bila bulan berjalan belum punya pengeluaran, kategori
 * diambil dari 60 hari terakhir dan tidak ada yang melewati ambang.
 */
export function buildDemoBudget(
  today: string,
  input: { currentMonth: readonly DemoCategorySpend[]; recent: readonly DemoCategorySpend[] },
): DemoBudgetSpec | null {
  if (!isValidDateString(today)) throw new RangeError(`Bukan tanggal YYYY-MM-DD yang sah: ${today}`);

  const { from, to } = monthBounds(today.slice(0, 7));
  const current = input.currentMonth.filter((category) => category.total > 0).sort(byTotalDesc);
  const recent = input.recent.filter((category) => category.total > 0).sort(byTotalDesc);
  const alert = current[0] ?? null;

  // Kategori alert lebih dulu, lalu kategori yang paling sering dipakai 60 hari terakhir.
  const selected = new Map<string, DemoCategorySpend>();
  if (alert) selected.set(alert.categoryId, alert);
  for (const category of recent) {
    if (selected.size >= 4) break;
    selected.set(category.categoryId, category);
  }
  if (selected.size === 0) return null;

  const currentById = new Map(current.map((category) => [category.categoryId, category.total]));
  const categories = [...selected.values()].map((category): DemoBudgetCategorySpec => {
    const spent = currentById.get(category.categoryId) ?? 0;
    const isAlert = alert?.categoryId === category.categoryId && spent > 0;
    return {
      categoryId: category.categoryId,
      name: category.name,
      slug: category.slug,
      // Pembulatan Rp100 aman untuk kategori biasa; kategori alert dibulatkan ke rupiah
      // penuh agar persentasenya tidak jatuh di bawah ambang hanya karena pembulatan.
      amount: isAlert ? Math.max(1, Math.ceil(spent / 0.9)) : Math.max(100_000, roundUpTo(spent / 0.5, 100)),
      alertThreshold: 80,
    };
  });

  const [year = '', month = ''] = today.split('-');
  const monthName = MONTH_NAMES[Number(month) - 1] ?? month;
  const totalAmount = roundUpTo(
    categories.reduce((sum, category) => sum + category.amount, 0) + 500_000,
    100_000,
  );

  return {
    name: `Anggaran ${monthName} ${year}`,
    periodStart: from,
    periodEnd: to,
    totalAmount,
    autoRenew: true,
    rolloverEnabled: false,
    categories,
    alertCategoryId: alert?.categoryId ?? null,
    alertSpent: alert?.total ?? 0,
  };
}

export interface DemoDailyStat {
  /** `YYYY-MM-DD`. */
  date: string;
  income: number;
  expense: number;
  topExpenseCategory: { name: string; total: number } | null;
}

export type DemoNotificationPayload = { date: string } | { budget_id: string; category_id: string };

export interface DemoNotificationSpec {
  type: 'daily_summary' | 'budget_alert';
  title: string;
  body: string;
  payload: DemoNotificationPayload;
  status: 'sent' | 'failed' | 'read';
  scheduledFor: Date | null;
  sentAt: Date | null;
  createdAt: Date;
}

export interface DemoNotificationInput {
  /** Hari-hari yang punya transaksi, terbaru dulu; hanya tanggal sebelum hari ini. */
  dailyStats: readonly DemoDailyStat[];
  budget: DemoBudgetSpec | null;
  /** Id baris `budgets` setelah tersimpan; null bila anggaran belum ada. */
  budgetId: string | null;
}

const atJakarta = (date: string, hour: number, minute: number): Date =>
  new Date(jakartaDayStartUtc(date).getTime() + (hour * 60 + minute) * 60_000);

/**
 * Tiga baris riwayat: ringkasan `sent`, ringkasan `failed`, dan peringatan anggaran `read`.
 * Status `read` tidak punya kolom waktunya sendiri; `sent_at` tetap diisi seperti produksi.
 */
export function buildDemoNotifications(today: string, input: DemoNotificationInput): DemoNotificationSpec[] {
  if (!isValidDateString(today)) throw new RangeError(`Bukan tanggal YYYY-MM-DD yang sah: ${today}`);

  const stats = input.dailyStats
    .filter((stat) => stat.date < today && (stat.income > 0 || stat.expense > 0))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 2);

  const specs: DemoNotificationSpec[] = [];
  const dailyAt = (stat: DemoDailyStat, status: 'sent' | 'failed'): DemoNotificationSpec => {
    const createdAt = atJakarta(stat.date, 20, 5);
    return {
      type: 'daily_summary',
      title: DAILY_SUMMARY_TITLE,
      body: dailySummary(stat),
      payload: { date: stat.date },
      status,
      scheduledFor: createdAt,
      sentAt: status === 'sent' ? new Date(createdAt.getTime() + 2 * 60_000) : null,
      createdAt,
    };
  };

  const [newest, older] = stats;
  if (newest) specs.push(dailyAt(newest, 'sent'));
  if (older) specs.push(dailyAt(older, 'failed'));

  const budget = input.budget;
  const category = budget?.categories.find((row) => row.categoryId === budget.alertCategoryId);
  if (budget && input.budgetId && category && budget.alertSpent > 0) {
    const createdAt = atJakarta(newest?.date ?? addDays(today, -1), 9, 15);
    specs.push({
      type: 'budget_alert',
      title: BUDGET_ALERT_TITLE,
      body: budgetAlert({
        budgetName: budget.name,
        categoryName: category.name,
        spent: budget.alertSpent,
        amount: category.amount,
      }),
      payload: { budget_id: input.budgetId, category_id: category.categoryId },
      status: 'read',
      scheduledFor: null,
      sentAt: new Date(createdAt.getTime() + 60_000),
      createdAt,
    });
  }

  return specs;
}
