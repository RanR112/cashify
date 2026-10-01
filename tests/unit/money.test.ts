import { describe, expect, it } from 'vitest';
import { formatRupiah, isRupiah, parseRupiah } from '../../src/shared/utils/money.js';

describe('formatRupiah', () => {
  it.each([
    [0, 'Rp0'],
    [999, 'Rp999'],
    [1000, 'Rp1.000'],
    [25000, 'Rp25.000'],
    [2350000, 'Rp2.350.000'],
    [1_000_000_000, 'Rp1.000.000.000'],
    [-5000, '-Rp5.000'],
  ])('%d -> %s', (amount, expected) => {
    expect(formatRupiah(amount)).toBe(expected);
  });

  it('tanpa spasi (Intl id-ID menyisipkan spasi tak-putus)', () => {
    expect(formatRupiah(25000)).not.toMatch(/\s/);
  });

  it.each([25.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])('menolak %s: uang harus bilangan bulat aman', (bad) => {
    expect(() => formatRupiah(bad)).toThrow(RangeError);
  });
});

describe('parseRupiah', () => {
  it.each([
    ['25000', 25000],
    ['  25000  ', 25000],
    ['25.000', 25000],
    ['25,000', 25000],
    ['Rp25.000', 25000],
    ['rp25.000', 25000],
    ['Rp. 25.000', 25000],
    ['Rp 1.000.000', 1_000_000],
    ['1.000.000', 1_000_000],
    ['1,000,000', 1_000_000],
    ['1.000.000.000', 1_000_000_000],
    ['0', 0],
  ])('%j -> %d', (input, expected) => {
    expect(parseRupiah(input)).toBe(expected);
  });

  it.each([
    ['desimal titik', '25.5'],
    ['desimal koma', '25,5'],
    ['dua digit di belakang pemisah', '1.00'],
    ['pemisah campur', '1,000.000'],
    ['desimal setelah ribuan', '1.000,50'],
    ['kelompok bukan tiga digit', '12.34.567'],
    ['pemisah ganda', '1..000'],
    ['diawali pemisah', '.000'],
    ['negatif', '-5000'],
    ['kosong', ''],
    ['hanya awalan', 'Rp'],
    ['huruf', 'abc'],
    ['sufiks ribu (urusan parser)', '25 ribu'],
    ['di luar rentang bilangan aman', '99999999999999999999'],
  ])('null untuk %s: %j', (_label, input) => {
    expect(parseRupiah(input)).toBeNull();
  });

  it('format lalu parse kembali menghasilkan nilai semula', () => {
    for (const amount of [1, 999, 1000, 25000, 123456789, 1_000_000_000]) {
      expect(parseRupiah(formatRupiah(amount))).toBe(amount);
    }
  });
});

describe('isRupiah', () => {
  it('hanya bilangan bulat aman bertipe number', () => {
    expect(isRupiah(25000)).toBe(true);
    expect(isRupiah(0)).toBe(true);
    expect(isRupiah(25000.5)).toBe(false);
    expect(isRupiah('25000')).toBe(false);
    expect(isRupiah(null)).toBe(false);
    expect(isRupiah(Number.NaN)).toBe(false);
  });
});
