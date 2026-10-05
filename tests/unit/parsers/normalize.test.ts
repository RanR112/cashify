// Tahap 1: normalisasi (ARCHITECTURE.md Bagian 7). Teks untuk pencocokan dirapikan; teks asli
// disimpan utuh karena itu yang ditampilkan kembali ke pengguna. Semua test di berkas ini harus
// GAGAL sampai P14 menulis src/parsers/normalize.ts.

import { describe, expect, it } from 'vitest';
import { parser } from './helpers.js';

describe('normalize: teks untuk pencocokan', () => {
  it.each([
    ['trim', '  makan siang  ', 'makan siang'],
    ['huruf besar semua', 'MAKAN SIANG 25 RIBU', 'makan siang 25 ribu'],
    ['huruf campur', 'Beli Kopi 18Rb', 'beli kopi 18rb'],
    ['spasi berlebih', 'makan    siang     25rb', 'makan siang 25rb'],
    ['tab menjadi spasi', 'makan\tsiang\t25rb', 'makan siang 25rb'],
    ['baris baru menjadi spasi', 'makan siang\n25rb', 'makan siang 25rb'],
    ['baris baru ganda dan CRLF', 'makan siang\r\n\r\n25rb', 'makan siang 25rb'],
    ['spasi tak terputus (NBSP)', 'makan siang 25rb', 'makan siang 25rb'],
    ['command tetap berawalan garis miring', '/KELUAR 25000 Makanan', '/keluar 25000 makanan'],
  ])('%s', async (_name, raw, expected) => {
    expect((await parser.normalize(raw)).text).toBe(expected);
  });

  it.each([
    ['titik ribuan', 'Rp25.000', 'rp25.000'],
    ['koma ribuan', 'beli 1,000,000', 'beli 1,000,000'],
    ['koma desimal', '1,5JT', '1,5jt'],
    ['tanda minus', 'beli baju -50000', 'beli baju -50000'],
    ['tanda tanya', 'Berapa pengeluaran bulan ini?', 'berapa pengeluaran bulan ini?'],
  ])('tanda baca dan angka tidak diubah: %s', async (_name, raw, expected) => {
    expect((await parser.normalize(raw)).text).toBe(expected);
  });
});

describe('normalize: emoji', () => {
  it.each([
    ['di awal', '🍔 25rb', '25rb'],
    ['di tengah (tanpa spasi ganda)', 'makan 🍕 siang 25rb', 'makan siang 25rb'],
    ['di akhir', 'makan siang 25rb 😋', 'makan siang 25rb'],
    ['menempel pada kata', 'kopi☕ 18rb', 'kopi 18rb'],
    ['emoji bermodifikasi dan gabungan (ZWJ)', '👨‍👩‍👧 jajan 50rb 👍🏽', 'jajan 50rb'],
  ])('dibuang dari teks pencocokan: %s', async (_name, raw, expected) => {
    expect((await parser.normalize(raw)).text).toBe(expected);
  });

  it('emoji tetap ada di teks asli', async () => {
    const result = await parser.normalize('🍔 25rb');
    expect(result.original).toBe('🍔 25rb');
    expect(result.text).not.toContain('🍔');
  });
});

describe('normalize: teks asli', () => {
  it.each([
    ['apa adanya, tanpa trim', '  Makan Siang 25 RIBU  '],
    ['dengan baris baru', 'makan\nsiang'],
    ['dengan emoji', '🍔 25rb'],
    ['kosong', ''],
  ])('tidak diubah: %s', async (_name, raw) => {
    expect((await parser.normalize(raw)).original).toBe(raw);
  });
});

describe('normalize: pesan kosong', () => {
  it.each([
    ['string kosong', ''],
    ['hanya spasi', '     '],
    ['hanya tab dan baris baru', '\t\n\r\n'],
    ['hanya NBSP', '  '],
    ['hanya emoji', '🍔🍔'],
    ['emoji dan spasi', ' 👍 '],
  ])('%s -> teks kosong', async (_name, raw) => {
    expect((await parser.normalize(raw)).text).toBe('');
  });
});

describe('normalize: sifat umum', () => {
  it.each(['  MAKAN   siang 🍔 25RB ', 'Rp 25.000', '/Keluar 25000', '\tYA\n', ''])(
    'idempoten: menormalkan hasilnya tidak mengubah apa pun (%j)',
    async (raw) => {
      const once = (await parser.normalize(raw)).text;
      expect((await parser.normalize(once)).text).toBe(once);
    },
  );

  it('murni: input yang sama selalu menghasilkan keluaran yang sama', async () => {
    expect(await parser.normalize('Makan 🍔 25RB')).toEqual(await parser.normalize('Makan 🍔 25RB'));
  });
});
