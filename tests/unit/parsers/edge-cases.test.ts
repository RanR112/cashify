// Keputusan yang dibuat saat implementasi P14 dan tidak tercakup test P13: kandidat nominal yang
// bersaing, bentuk angka yang tidak bisa dipastikan, pemilihan kategori saat beberapa cocok, dan
// tepi tanggal. Prinsip yang sama: tidak pasti -> bertanya, tidak menebak.

import { describe, expect, it } from 'vitest';
import { parser } from './helpers.js';

async function amountOf(raw: string, type: 'income' | 'expense' = 'expense') {
  const { text } = await parser.normalize(raw);
  return parser.extractAmount(text, type);
}

async function dateOf(raw: string) {
  const { text } = await parser.normalize(raw);
  return parser.extractDate(text);
}

describe('nominal: kandidat yang bersaing', () => {
  it.each([
    ['dua nominal berbeda dengan sufiks', 'beli kopi 36rb dan roti 50rb'],
    ['dua angka telanjang berbeda', 'beli 3 kopi 20'],
    ['dua nominal berpemisah berbeda', 'beli 1.500 dan 2.500'],
  ])('%s -> missing: tidak ada dasar memilih, jadi bertanya', async (_name, raw) => {
    expect(await amountOf(raw)).toEqual({ status: 'missing' });
  });

  it('nominal yang sama ditulis dua kali bukan persaingan', async () => {
    expect(await amountOf('25rb 25rb makan')).toMatchObject({ status: 'found', amount: 25_000 });
  });

  it('sufiks mengalahkan angka telanjang, dan berpemisah mengalahkan telanjang', async () => {
    expect(await amountOf('beli 3 kopi 15.000')).toMatchObject({ status: 'found', amount: 15_000 });
  });
});

describe('nominal: bentuk angka yang tidak bisa dipastikan dibiarkan tak terbaca', () => {
  it.each([
    ['desimal tanpa sufiks', 'makan 25.5'],
    ['mirip jam', 'makan jam 12.30'],
    ['pemisah tidak beraturan', 'beli 1.5.5jt'],
    ['angka menempel huruf', 'beli 2kg'],
  ])('%s -> missing', async (_name, raw) => {
    expect(await amountOf(raw)).toEqual({ status: 'missing' });
  });

  it('tiga digit di belakang pemisah dengan sufiks dibaca pemisah ribuan (konvensi Indonesia)', async () => {
    expect(await amountOf('beli 1.000 rb')).toMatchObject({ status: 'found', amount: 1_000_000 });
  });

  it('"rp" membuat angka kecil dibaca apa adanya, bukan ribuan', async () => {
    expect(await amountOf('bayar rp5')).toMatchObject({ status: 'found', amount: 5, assumedThousands: false });
  });

  it('angka sangat panjang ditolak, bukan meluap', async () => {
    expect(await amountOf(`beli ${'9'.repeat(400)}`)).toMatchObject({ status: 'rejected', reason: 'too_large' });
  });
});

describe('kategori: beberapa kata kunci cocok', () => {
  const dictionary = [
    { slug: 'home', name: 'Rumah', type: 'expense' as const, keywords: ['rumah'] },
    { slug: 'health', name: 'Kesehatan', type: 'expense' as const, keywords: ['rumah sakit'] },
    { slug: 'copy', name: 'Salinan', type: 'expense' as const, keywords: ['rumah'] },
  ];

  it('yang muncul paling awal menang', async () => {
    expect(await parser.classifyCategory('kopi lalu rumah sakit', [
      { slug: 'a', name: 'A', type: 'expense' as const, keywords: ['rumah sakit'] },
      { slug: 'b', name: 'B', type: 'expense' as const, keywords: ['kopi'] },
    ])).toMatchObject({ slug: 'b' });
  });

  it('di posisi yang sama, istilah lebih panjang menang', async () => {
    expect(await parser.classifyCategory('ke rumah sakit', dictionary)).toMatchObject({ slug: 'health' });
  });

  it('seri penuh: urutan kamus menentukan', async () => {
    expect(await parser.classifyCategory('beli rumah', dictionary)).toMatchObject({ slug: 'home' });
  });
});

describe('tanggal: tepi', () => {
  it('"N hari lalu" yang absurd ditolak tanpa menghitung tanggalnya', async () => {
    expect(await dateOf('makan 4000 hari lalu')).toMatchObject({ status: 'rejected', reason: 'too_old' });
  });

  it('"N hari lalu" yang melewati satu tahun ditolak', async () => {
    expect(await dateOf('makan 400 hari lalu')).toMatchObject({ status: 'rejected', reason: 'too_old' });
  });

  it('0 hari lalu adalah hari ini', async () => {
    expect(await dateOf('makan 0 hari lalu')).toMatchObject({ status: 'found', date: '2026-09-30' });
  });

  it('minggu (hari) kemarin: Minggu terakhir yang sudah lewat', async () => {
    expect(await dateOf('minggu kemarin makan')).toMatchObject({ status: 'found', date: '2026-09-27' });
  });

  it('"tgl 5" dibaca tanggal 5 bulan berjalan', async () => {
    expect(await dateOf('tgl 5 makan')).toMatchObject({ status: 'found', date: '2026-09-05' });
  });
});

describe('parseMessage: tepi', () => {
  it('"ubah jadi 20": nominal telanjang tidak dibawa, alur percakapan yang bertanya', async () => {
    const result = await parser.parseMessage('ubah jadi 20');
    expect(result).toMatchObject({ outcome: 'intent', intent: 'CORRECT' });
    expect(result).not.toHaveProperty('amount');
  });

  it('"ubah kategori jadi makanan": CORRECT tanpa nominal', async () => {
    const result = await parser.parseMessage('ubah kategori jadi makanan');
    expect(result).toMatchObject({ outcome: 'intent', intent: 'CORRECT' });
    expect(result).not.toHaveProperty('amount');
  });

  it('kamus disaring menurut tipe: "masuk tol 15rb" (penanda pemasukan) tidak menjadi Transportasi', async () => {
    expect(await parser.parseMessage('masuk tol 15rb')).toMatchObject({
      outcome: 'clarify',
      ask: 'category',
      type: 'income',
      amount: 15_000,
    });
  });

  it('dua nominal bersaing: bertanya nominal, tidak menebak', async () => {
    const result = await parser.parseMessage('beli kopi 36rb dan roti 50rb');
    expect(result).toMatchObject({ outcome: 'clarify', ask: 'amount', categorySlug: 'food' });
    expect(result).not.toHaveProperty('amount');
  });

  it('jawaban klarifikasi nominal harus berupa nominal saja', async () => {
    expect(await parser.parseMessage('25rb', { awaiting: 'amount' })).toMatchObject({ intent: 'CLARIFY_RESPONSE' });
    expect(await parser.parseMessage('makan 25rb', { awaiting: 'amount' })).toMatchObject({ outcome: 'ready' });
  });
});
