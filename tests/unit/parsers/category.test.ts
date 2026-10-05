// Tahap 5: tipe transaksi dan kategori, kamus dulu (ARCHITECTURE.md Bagian 7 dan 17). Kamus
// kata kunci masuk sebagai ARGUMEN (aturan 9: parsers/ tidak membaca database). Kategori diuji lewat
// SLUG ("food"), bukan nama tampilan ("Makanan"). Semua test di berkas ini harus GAGAL sampai P14
// menulis src/parsers/category.ts.

import { describe, expect, it } from 'vitest';
import { DICTIONARY, parser } from './helpers.js';

async function categoryOf(raw: string, dictionary = DICTIONARY) {
  const { text } = await parser.normalize(raw);
  return parser.classifyCategory(text, dictionary);
}

async function typeOf(raw: string) {
  const { text } = await parser.normalize(raw);
  return parser.classifyType(text);
}

const matched = (slug: string) => ({ status: 'matched', slug });
const unknown = { status: 'unknown' };

describe('tipe: penanda pemasukan (Bagian 7), selain itu pengeluaran', () => {
  it.each([
    ['gaji', 'gaji bulan ini 5 juta'],
    ['bonus', 'bonus 500rb'],
    ['thr', 'thr 1jt'],
    ['dapat', 'dapat 200rb dari freelance'],
    ['terima', 'terima transferan 200rb'],
    ['masuk', 'masuk 100rb'],
    ['untung', 'untung jualan 50rb'],
    ['dibayar', 'dibayar klien 1jt'],
    ['fee', 'fee desain 500rb'],
    ['komisi', 'komisi 200rb'],
    ['huruf besar', 'GAJI BULAN INI 5 JUTA'],
  ])('%s -> income', async (_name, raw) => {
    expect(await typeOf(raw)).toBe('income');
  });

  it.each([
    ['makan siang', 'makan siang 25rb'],
    ['isi bensin', 'isi bensin 50k'],
    ['bayar listrik', 'bayar listrik 350rb'],
    ['"keluar" tanpa kategori', 'keluar 50 ribu'],
    ['hanya nominal (asumsi pengeluaran, Bagian 17)', '100rb'],
    ['tanpa nominal', 'tadi beli sesuatu'],
    ['kosong', ''],
  ])('%s -> expense', async (_name, raw) => {
    expect(await typeOf(raw)).toBe('expense');
  });

  it.each([
    ['"bayar" bukan "dibayar"', 'bayar listrik 350rb'],
    ['"fee" di dalam "coffee" bukan penanda pemasukan', 'beli coffee 18k'],
    ['tidak ada kata yang mirip penanda', 'bayar tiket kereta 20rb'],
  ])('batas kata: %s -> expense', async (_name, raw) => {
    expect(await typeOf(raw)).toBe('expense');
  });
});

describe('kategori: contoh dari spesifikasi dan Bagian 7', () => {
  it.each([
    ['makan siang -> makanan', 'makan siang', 'food'],
    ['isi bensin -> transportasi', 'isi bensin', 'transport'],
    ['bayar listrik -> tagihan', 'bayar listrik', 'bills'],
    ['belanja 100 ribu -> belanja (Bagian 17)', 'belanja 100 ribu', 'shopping'],
    ['beli baju -> belanja', 'beli baju', 'shopping'],
    ['nonton bioskop -> hiburan', 'nonton bioskop', 'entertainment'],
    ['obat -> kesehatan', 'beli obat', 'health'],
    ['gaji -> gaji', 'gaji bulan ini', 'salary'],
    ['bonus -> bonus', 'dapat bonus', 'bonus'],
    ['thr -> bonus', 'thr lebaran', 'bonus'],
    ['komisi -> freelance', 'komisi penjualan', 'freelance'],
    ['isi bensin 50k (contoh Bagian 6)', 'isi bensin 50k', 'transport'],
    ['tadi makan siang 25 ribu (contoh Bagian 6)', 'tadi makan siang 25 ribu', 'food'],
    ['bayar listrik 350.000 (contoh Bagian 6)', 'bayar listrik 350.000', 'bills'],
  ])('%s', async (_name, raw, slug) => {
    expect(await categoryOf(raw)).toMatchObject(matched(slug));
  });
});

describe('kategori: kata generik "beli" kalah dari kata kunci lain', () => {
  // KEPUTUSAN PRODUK yang dikodekan di sini: "beli" ada di kamus Belanja, tetapi hampir selalu
  // menyertai barang lain ("beli kopi", "beli bensin"). Kata kunci yang lebih spesifik harus menang;
  // "beli" hanya menentukan kategori bila tidak ada kata kunci lain. Contoh Bagian 6/17:
  // "beli kopi 18rb" dan "beli makan 20" jelas Makanan, bukan Belanja.
  it.each([
    ['beli kopi 18rb', 'food'],
    ['beli makan 20', 'food'],
    ['beli nasi goreng', 'food'],
    ['beli bensin 50rb', 'transport'],
    ['beli obat 30rb', 'health'],
    ['beli tiket nonton', 'entertainment'],
    ['beli pulsa 25rb', 'bills'],
    ['beli token listrik 100rb', 'bills'],
  ])('"%s" -> %s', async (raw, slug) => {
    expect(await categoryOf(raw)).toMatchObject(matched(slug));
  });

  it.each([
    ['beli baju', 'shopping'],
    ['beli sesuatu', 'shopping'],
    ['tadi beli sesuatu', 'shopping'],
    ['beli sepatu 300rb', 'shopping'],
  ])('"%s" (hanya "beli" atau kata Belanja) -> %s', async (raw, slug) => {
    expect(await categoryOf(raw)).toMatchObject(matched(slug));
  });
});

describe('kategori: kata kunci hanya cocok sebagai kata utuh, bukan potongan kata lain', () => {
  it.each([
    ['"ayam" di dalam "bayam"', 'bayam 5rb'],
    ['"air" di dalam "cairan"', 'cairan pel 20rb'],
    ['"tol" di dalam "pistol"', 'pistol mainan 50rb'],
  ])('%s -> unknown', async (_name, raw) => {
    expect(await categoryOf(raw)).toEqual(unknown);
  });

  it('"grabfood" adalah Makanan, bukan Transportasi lewat "grab"', async () => {
    expect(await categoryOf('grabfood 30rb')).toMatchObject(matched('food'));
  });

  it('"gojek" tetap Transportasi', async () => {
    expect(await categoryOf('gojek 20rb')).toMatchObject(matched('transport'));
  });

  it('kata kunci lebih dari satu kata: "rumah sakit"', async () => {
    expect(await categoryOf('ke rumah sakit 500rb')).toMatchObject(matched('health'));
  });
});

describe('kategori: nama kategori yang disebut pengguna (mis. argumen command)', () => {
  it.each([
    ['makanan', 'food'],
    ['transportasi', 'transport'],
    ['belanja', 'shopping'],
    ['tagihan', 'bills'],
    ['kesehatan', 'health'],
    ['hiburan', 'entertainment'],
    ['gaji', 'salary'],
    ['investasi', 'investment'],
    ['MAKANAN', 'food'],
  ])('"%s" -> %s', async (raw, slug) => {
    expect(await categoryOf(raw)).toMatchObject(matched(slug));
  });
});

describe('kategori: bahasa dan penulisan (Bagian 17)', () => {
  // Tiga baris pertama (mkn, lunch, coffee) baru hijau setelah P14 menambah varian ke kamus seed
  // (prisma/seed-data.ts): Bagian 17 menyatakan "kamus kata kunci memuat varian umum" dan "kamus
  // memuat istilah Inggris umum". Dua baris terakhir hanya menjaga normalisasi.
  it.each([
    ['typo: mkn siang', 'mkn siang 25rb', 'food'],
    ['campur bahasa: lunch', 'lunch 25 ribu', 'food'],
    ['campur bahasa: coffee', 'beli coffee 18k', 'food'],
    ['huruf besar semua', 'MAKAN SIANG 25 RIBU', 'food'],
    ['emoji dibuang, kata tetap terbaca', '🍔 makan 25rb', 'food'],
  ])('%s', async (_name, raw, slug) => {
    expect(await categoryOf(raw)).toMatchObject(matched(slug));
  });
});

describe('kategori: tidak jelas -> unknown (pipeline lalu bertanya)', () => {
  it.each([
    ['"keluar 50 ribu" (spesifikasi, Bagian 17)', 'keluar 50 ribu'],
    ['hanya nominal', '100rb'],
    ['sapaan', 'halo'],
    ['bahasa daerah (tidak didukung)', 'tuku sego 15ewu'],
    ['dua angka tanpa kategori', 'transfer 100 rb ke 2 orang'],
    ['singkatan dompet digital tanpa kategori', 'gopay 20rb'],
    ['hanya emoji', '🍔'],
    ['kosong', ''],
  ])('%s', async (_name, raw) => {
    expect(await categoryOf(raw)).toEqual(unknown);
  });

});

describe('kategori: kamus adalah argumen, bukan data yang tertanam', () => {
  it('kamus kustom dipakai apa adanya', async () => {
    const pets = [{ slug: 'pets', name: 'Hewan', type: 'expense' as const, keywords: ['kucing'] }];
    expect(await categoryOf('beli pasir kucing 50rb', pets)).toMatchObject(matched('pets'));
    expect(await categoryOf('makan siang 25rb', pets)).toEqual(unknown);
  });

  it('kamus kosong: tidak ada yang cocok', async () => {
    expect(await categoryOf('makan siang 25rb', [])).toEqual(unknown);
  });

  it('tidak mengubah kamus yang diberikan (kamus dibekukan; mutasi akan melempar)', async () => {
    const before = JSON.stringify(DICTIONARY);
    await categoryOf('beli kopi 18rb');
    expect(JSON.stringify(DICTIONARY)).toBe(before);
  });

  it('deterministik: input yang sama selalu menghasilkan kategori yang sama', async () => {
    expect(await categoryOf('beli kopi 18rb')).toEqual(await categoryOf('beli kopi 18rb'));
  });
});

describe('kategori: setiap kata kunci di kamus seed menghasilkan kategorinya', () => {
  // Dibangkitkan dari kamus yang sama dengan yang dipakai pipeline, jadi pengaman bila kata kunci
  // ditambah atau digeser di seed tanpa parser mengikuti.
  const rows = DICTIONARY.flatMap((category) =>
    category.keywords.map((keyword) => [category.slug, keyword] as [string, string]),
  );

  it.each(rows)('%s <- "%s"', async (slug, keyword) => {
    expect(await categoryOf(`tadi ${keyword} 25rb`)).toMatchObject(matched(slug));
  });
});
