// Uang adalah bilangan bulat rupiah (aturan 1). Tidak ada Float, Decimal, atau sen.
// Sufiks "ribu", "rb", "k" dan penebakan "20" menjadi Rp20.000 adalah urusan parser
// (src/parsers/amount.ts), bukan fungsi di sini.

export function isRupiah(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** 25000 -> "Rp25.000"; -5000 -> "-Rp5.000". Tanpa spasi, sesuai gaya balasan bot. */
export function formatRupiah(amount: number): string {
  if (!isRupiah(amount)) {
    throw new RangeError(`Nominal harus bilangan bulat, diterima: ${amount}`);
  }
  const grouped = Math.abs(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${amount < 0 ? '-' : ''}Rp${grouped}`;
}

const PREFIX = /^rp\.?\s*/i;
const PLAIN = /^\d+$/;
// Pemisah ribuan harus konsisten (semua titik atau semua koma) dan membentuk kelompok tiga digit.
const GROUPED = /^\d{1,3}([.,])\d{3}(?:\1\d{3})*$/;

/**
 * Membaca nominal yang sudah ditulis utuh: "Rp25.000", "1.000.000", "1,000,000", "25000".
 * Mengembalikan null untuk apa pun yang ambigu atau bukan bilangan bulat: desimal ("25.5"),
 * pemisah campur ("1.000,50"), negatif, kosong, atau teks lain.
 */
export function parseRupiah(input: string): number | null {
  const text = input.trim().replace(PREFIX, '');
  let digits: string;
  if (PLAIN.test(text)) {
    digits = text;
  } else if (GROUPED.test(text)) {
    digits = text.replace(/[.,]/g, '');
  } else {
    return null;
  }
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}
