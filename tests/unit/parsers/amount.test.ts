// Tahap 3: ekstraksi nominal, REGEX SAJA (ARCHITECTURE.md Bagian 7 dan 17). Bagian paling kritis di
// seluruh sistem: salah di sini berarti kerugian finansial langsung bagi pengguna. Prinsipnya:
// nominal tidak jelas atau tidak ada -> bertanya, tidak pernah menebak. Semua test di berkas ini
// harus GAGAL sampai P14 menulis src/parsers/amount.ts.

import { describe, expect, it } from 'vitest';
import { parser } from './helpers.js';

type Kind = 'income' | 'expense';

/** Tahap 1 lalu tahap 3, seperti di pipeline: extractAmount menerima teks yang sudah dinormalisasi. */
async function amountOf(raw: string, type: Kind = 'expense') {
  const { text } = await parser.normalize(raw);
  return parser.extractAmount(text, type);
}

const found = (amount: number, assumedThousands = false) => ({ status: 'found', amount, assumedThousands });

describe('nominal: bentuk penulisan (Bagian 7)', () => {
  it.each<[string, string, number]>([
    // Angka polos dan pemisah ribuan
    ['angka polos', '25000', 25000],
    ['titik sebagai pemisah ribuan', '25.000', 25000],
    ['koma sebagai pemisah ribuan', '25,000', 25000],
    ['titik ribuan berlapis', '1.000.000', 1_000_000],
    ['koma ribuan berlapis', '1,000,000', 1_000_000],
    ['pemisah ribuan tujuh digit', '1.250.000', 1_250_000],
    // Sufiks ribuan
    ['rb', '25rb', 25000],
    ['ribu dengan spasi', '25 ribu', 25000],
    ['k huruf kecil', '25k', 25000],
    ['K huruf besar', '25K', 25000],
    ['ribu tanpa spasi', '50ribu', 50000],
    ['rb dengan spasi', '50 rb', 50000],
    ['RB huruf besar', '100 RB', 100000],
    ['Rb huruf campur', '75Rb', 75000],
    ['Ribu huruf campur', '10 Ribu', 10000],
    // Sufiks juta, desimal titik atau koma
    ['juta desimal titik', '1.5 juta', 1_500_000],
    ['jt desimal koma', '1,5jt', 1_500_000],
    ['M sebagai juta', '1.5M', 1_500_000],
    ['juta bulat', '5 juta', 5_000_000],
    ['jt bulat', '2jt', 2_000_000],
    ['jt dengan spasi', '1.5 jt', 1_500_000],
    ['juta desimal koma', '2,5 juta', 2_500_000],
    ['kurang dari satu juta', '0,5 juta', 500_000],
    // Desimal pada ribuan (Bagian 17)
    ['desimal pada ribu', '25.5 ribu', 25_500],
    ['desimal koma pada k', '1,5k', 1_500],
    ['desimal koma pada rb', '3,5 rb', 3_500],
    // Prefiks mata uang
    ['Rp tanpa spasi', 'Rp25.000', 25000],
    ['rp dengan spasi', 'rp 25000', 25000],
    ['Rp dengan titik setelahnya', 'Rp.25.000', 25000],
    ['Rp dengan spasi dan pemisah', 'Rp 1.000.000', 1_000_000],
    ['Rp dengan sufiks', 'rp25rb', 25000],
  ])('%s: "%s" -> %i', async (_name, raw, expected) => {
    expect(await amountOf(raw)).toMatchObject(found(expected));
  });

  it.each<[string, string, number, Kind?]>([
    ['makan siang', 'tadi makan siang 25 ribu', 25000],
    ['kopi', 'beli kopi 18rb', 18000],
    ['listrik dengan titik ribuan', 'bayar listrik 350.000', 350000],
    ['gaji dengan juta (pemasukan)', 'gaji bulan ini 5 juta', 5_000_000, 'income'],
    ['bensin dengan k', 'isi bensin 50k', 50000],
    ['singkatan dompet digital', 'gopay 20rb', 20000],
    ['nominal di awal kalimat', '25rb makan siang', 25000],
    ['nominal di tengah', 'makan 25rb di warteg', 25000],
    ['huruf besar semua', 'MAKAN SIANG 25 RIBU', 25000],
    ['dengan emoji', '🍔 25rb', 25000],
  ])('di dalam kalimat: %s', async (_name, raw, expected, type = 'expense') => {
    expect(await amountOf(raw, type)).toMatchObject(found(expected));
  });
});

describe('nominal: dibangkitkan dari pola (sufiks dan pemisah)', () => {
  const group = (n: number, sep: string): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);

  const thousandSuffixes = ['rb', 'ribu', 'k', ' rb', ' ribu', ' k'];
  const millionSuffixes = ['jt', 'juta', ' jt', ' juta'];

  it.each(['1', '7', '25', '100', '999'].flatMap((n) => thousandSuffixes.map((s) => [`${n}${s}`, Number(n) * 1000] as const)))(
    'ribuan: "%s" -> %i',
    async (raw, expected) => {
      expect(await amountOf(`beli sesuatu ${raw}`)).toMatchObject(found(expected));
    },
  );

  it.each(['1', '2', '15', '250'].flatMap((n) => millionSuffixes.map((s) => [`${n}${s}`, Number(n) * 1_000_000] as const)))(
    'jutaan: "%s" -> %i',
    async (raw, expected) => {
      expect(await amountOf(`beli sesuatu ${raw}`)).toMatchObject(found(expected));
    },
  );

  it.each([1000, 25_000, 150_000, 1_250_000].flatMap((n) => [
    [String(n), n] as const,
    [group(n, '.'), n] as const,
    [group(n, ','), n] as const,
    [`rp${group(n, '.')}`, n] as const,
  ]))('pemisah ribuan: "%s" -> %i', async (raw, expected) => {
    expect(await amountOf(`bayar ${raw}`)).toMatchObject(found(expected));
  });
});

describe('nominal: ambiguitas (Bagian 7 "Heuristik" dan Bagian 17)', () => {
  it.each<[string, string, number]>([
    ['beli makan 20', 'beli makan 20', 20_000],
    ['angka satu digit', 'beli permen 5', 5_000],
    ['tepat di bawah batas', 'beli sepatu 999', 999_000],
    ['tiga digit', 'makan 500', 500_000],
  ])('pengeluaran di bawah 1.000 tanpa sufiks dibaca ribuan dan ditandai: %s', async (_name, raw, expected) => {
    expect(await amountOf(raw, 'expense')).toMatchObject(found(expected, true));
  });

  it.each<[string, string, number]>([
    ['tepat 1.000', 'beli pulpen 1000', 1000],
    ['1.500 polos', 'beli permen 1500', 1500],
    ['5.000 polos', 'parkir 5000', 5000],
  ])('pengeluaran 1.000 ke atas dibaca apa adanya: %s', async (_name, raw, expected) => {
    expect(await amountOf(raw, 'expense')).toMatchObject(found(expected, false));
  });

  it.each<[string, string, number]>([
    ['gaji 5', 'gaji 5', 5],
    ['gaji 500', 'gaji 500', 500],
    ['gaji 999', 'gaji 999', 999],
    ['bonus 20', 'bonus 20', 20],
  ])('pemasukan di bawah 1.000 tanpa sufiks TIDAK ditebak, harus bertanya: %s', async (_name, raw, value) => {
    expect(await amountOf(raw, 'income')).toMatchObject({ status: 'ambiguous', reason: 'bare_income', value });
  });

  it.each<[string, string, number]>([
    ['gaji 5 juta', 'gaji 5 juta', 5_000_000],
    ['gaji 5jt', 'gaji 5jt', 5_000_000],
    ['gaji 5rb', 'gaji 5rb', 5000],
    ['gaji 5000', 'gaji 5000', 5000],
    ['bonus 1.000.000', 'bonus 1.000.000', 1_000_000],
  ])('pemasukan yang jelas tidak ditanyakan: %s', async (_name, raw, expected) => {
    expect(await amountOf(raw, 'income')).toMatchObject(found(expected, false));
  });

  it.each<[string, string, number]>([
    ['jumlah barang lalu nominal', 'beli 3 kopi 54 ribu', 54_000],
    ['jumlah barang di antara', 'beli 2 kopi 36rb', 36_000],
    ['nominal lalu jumlah orang', 'makan 25rb 2 orang', 25_000],
    ['dua angka, sufiks menandai nominal', 'transfer 100 rb ke 2 orang', 100_000],
    ['jumlah di depan', '3 porsi bakso 45k', 45_000],
  ])('beberapa angka: sufiks/penanda mata uang menentukan nominal, angka lain diabaikan: %s', async (_name, raw, expected) => {
    expect(await amountOf(raw)).toMatchObject(found(expected, false));
  });
});

describe('nominal: penolakan', () => {
  it.each<[string, string]>([
    ['nominal absurd', 'makan 999999999999'],
    ['satu rupiah di atas batas Rp1 miliar', 'makan 1000000001'],
    ['dengan pemisah ribuan', 'beli mobil 2.500.000.000'],
    ['dari sufiks juta', 'beli motor 2000 juta'],
  ])('di atas Rp1 miliar ditolak: %s', async (_name, raw) => {
    expect(await amountOf(raw)).toMatchObject({ status: 'rejected', reason: 'too_large' });
  });

  it.each<[string, string, number]>([
    ['tepat Rp1 miliar', 'beli tanah 1000000000', 1_000_000_000],
    ['Rp1 miliar dengan pemisah', 'beli tanah 1.000.000.000', 1_000_000_000],
    ['1000 juta', 'beli tanah 1000 juta', 1_000_000_000],
  ])('batas atas masih sah: %s', async (_name, raw, expected) => {
    expect(await amountOf(raw)).toMatchObject(found(expected));
  });

  it.each<[string, string]>([
    ['minus menempel pada angka', 'beli baju -50000'],
    ['minus dengan sufiks', 'beli baju -50rb'],
    ['minus dengan pemisah ribuan', 'beli -25.000'],
    ['minus di awal pesan', '-50000 baju'],
  ])('negatif ditolak (tipe ditentukan `type`, bukan tanda): %s', async (_name, raw) => {
    expect(await amountOf(raw)).toMatchObject({ status: 'rejected', reason: 'negative' });
  });

  it.each<[string, string]>([
    ['beli 0', 'beli 0'],
    ['Rp0', 'beli rp0'],
    ['0 rb', 'beli 0 rb'],
    ['0 juta', 'beli 0 juta'],
    ['000', 'beli 000'],
  ])('nol ditolak: %s', async (_name, raw) => {
    expect(await amountOf(raw)).toMatchObject({ status: 'rejected', reason: 'zero' });
  });

  it.each<[string, string]>([
    ['spasi di kedua sisi', 'kopi - 18rb'],
    ['menempel pada kata', 'kopi-18rb'],
    ['tanda hubung dengan spasi sebelum angka', 'makan siang - 25 ribu'],
  ])('tanda hubung sebagai pemisah BUKAN tanda negatif: %s', async (_name, raw) => {
    expect(await amountOf(raw)).toMatchObject(found(raw.includes('18') ? 18000 : 25000));
  });
});

describe('nominal: tidak ada', () => {
  it.each([
    ['tidak ada angka', 'tadi beli sesuatu'],
    ['kategori terdeteksi tetapi nominal kosong', 'bayar listrik'],
    ['sapaan', 'halo'],
    ['kosong', ''],
    ['hanya emoji', '🍔'],
    ['sufiks tanpa angka', 'beli ribu'],
  ])('%s -> missing (pipeline berhenti dan bertanya, tanpa default)', async (_name, raw) => {
    expect(await amountOf(raw)).toEqual({ status: 'missing' });
  });
});

describe('nominal: sifat umum', () => {
  it('hasilnya selalu bilangan bulat rupiah (aturan 1)', async () => {
    for (const raw of ['25.5 ribu', '1,5jt', '0,5 juta', '3,5 rb', '1.5M', 'beli 20']) {
      const result = await amountOf(raw);
      expect(result.status).toBe('found');
      if (result.status === 'found') expect(Number.isInteger(result.amount)).toBe(true);
    }
  });

  it('murni: input yang sama selalu menghasilkan hasil yang sama', async () => {
    expect(await amountOf('beli 3 kopi 54 ribu')).toEqual(await amountOf('beli 3 kopi 54 ribu'));
  });
});
