// Data murni untuk seed kategori sistem. Tidak mengimpor Prisma supaya bisa diuji unit.
//
// Kata kunci pengeluaran diambil dari ARCHITECTURE.md Bagian 7 tahap 5. Bagian itu
// hanya mendaftar enam kategori pengeluaran; "Lainnya" adalah kategori cadangan
// (Bagian 7: kategori tak dikenal menjadi "Lainnya", bukan kategori baru).
//
// Lima kategori pemasukan TIDAK didaftar di dokumen mana pun. Nama, slug, dan
// pembagian kata kuncinya di bawah adalah usulan; penanda tipe pemasukan
// (gaji, bonus, thr, fee, komisi, untung) dari Bagian 7 dibagikan ke kategori
// yang paling cocok. Kata `dapat`, `terima`, `masuk`, `dibayar` sengaja tidak
// dimasukkan: itu penentu TIPE pemasukan, bukan penentu kategori.
//
// Semua kata kunci huruf kecil, karena parser mencocokkan setelah normalisasi.

export interface SystemCategorySeed {
  slug: string;
  name: string;
  type: 'income' | 'expense';
  icon: string;
  color: string;
  keywords: string[];
  sortOrder: number;
}

export const EXPENSE_CATEGORIES: SystemCategorySeed[] = [
  {
    slug: 'food',
    name: 'Makanan',
    type: 'expense',
    icon: 'utensils',
    color: '#F97316',
    // 'mkn', 'lunch', 'coffee': varian umum (typo dan istilah Inggris), ARCHITECTURE.md Bagian 17.
    keywords: ['makan', 'nasi', 'ayam', 'kopi', 'sarapan', 'jajan', 'gofood', 'grabfood', 'warteg', 'bakso', 'mkn', 'lunch', 'coffee'],
    sortOrder: 1,
  },
  {
    slug: 'transport',
    name: 'Transportasi',
    type: 'expense',
    icon: 'car',
    color: '#3B82F6',
    keywords: ['bensin', 'grab', 'gojek', 'ojek', 'parkir', 'tol', 'busway', 'kereta', 'taksi', 'pertalite'],
    sortOrder: 2,
  },
  {
    slug: 'shopping',
    name: 'Belanja',
    type: 'expense',
    icon: 'shopping-bag',
    color: '#EC4899',
    keywords: ['beli', 'shopee', 'tokopedia', 'baju', 'sepatu', 'belanja'],
    sortOrder: 3,
  },
  {
    slug: 'bills',
    name: 'Tagihan',
    type: 'expense',
    icon: 'receipt',
    color: '#EAB308',
    keywords: ['listrik', 'air', 'pdam', 'internet', 'wifi', 'pulsa', 'token', 'bpjs', 'cicilan', 'kos'],
    sortOrder: 4,
  },
  {
    slug: 'health',
    name: 'Kesehatan',
    type: 'expense',
    icon: 'heart-pulse',
    color: '#EF4444',
    keywords: ['obat', 'dokter', 'apotek', 'vitamin', 'rumah sakit', 'klinik'],
    sortOrder: 5,
  },
  {
    slug: 'entertainment',
    name: 'Hiburan',
    type: 'expense',
    icon: 'clapperboard',
    color: '#8B5CF6',
    keywords: ['nonton', 'bioskop', 'netflix', 'spotify', 'game', 'konser', 'liburan'],
    sortOrder: 6,
  },
  {
    slug: 'other_expense',
    name: 'Lainnya',
    type: 'expense',
    icon: 'ellipsis',
    color: '#6B7280',
    keywords: [], // cadangan; tidak pernah cocok lewat kata kunci
    sortOrder: 7,
  },
];

export const INCOME_CATEGORIES: SystemCategorySeed[] = [
  {
    slug: 'salary',
    name: 'Gaji',
    type: 'income',
    icon: 'wallet',
    color: '#16A34A',
    keywords: ['gaji'],
    sortOrder: 1,
  },
  {
    slug: 'bonus',
    name: 'Bonus',
    type: 'income',
    icon: 'gift',
    color: '#22C55E',
    keywords: ['bonus', 'thr'],
    sortOrder: 2,
  },
  {
    slug: 'freelance',
    name: 'Freelance',
    type: 'income',
    icon: 'briefcase',
    color: '#14B8A6',
    keywords: ['fee', 'komisi', 'freelance'],
    sortOrder: 3,
  },
  {
    slug: 'investment',
    name: 'Investasi',
    type: 'income',
    icon: 'trending-up',
    color: '#0EA5E9',
    keywords: ['untung', 'dividen'],
    sortOrder: 4,
  },
  {
    slug: 'other_income',
    name: 'Lainnya',
    type: 'income',
    icon: 'ellipsis',
    color: '#6B7280',
    keywords: [], // cadangan; tidak pernah cocok lewat kata kunci
    sortOrder: 5,
  },
];

export const SYSTEM_CATEGORIES: SystemCategorySeed[] = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES];
