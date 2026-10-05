// Tahap 4: ekstraksi tanggal, REGEX SAJA, acuan zona Asia/Jakarta (ARCHITECTURE.md Bagian 7 dan 17).
// Tanggal masa depan dan lebih dari satu tahun ke belakang ditolak; tanggal yang kabur ditolak.
// Semua test di berkas ini harus GAGAL sampai P14 menulis src/parsers/date.ts.
//
// Kalender acuan: NOW = Rabu 2026-09-30. Senin 2026-10-05 dipakai untuk kasus "hari ini Senin".
//   Rab 09-23 | Kam 09-24 | Jum 09-25 | Sab 09-26 | Min 09-27 | Sen 09-28 | Sel 09-29 | Rab 09-30

import { describe, expect, it } from 'vitest';
import { NOW, parser, wib } from './helpers.js';

/** Tahap 1 lalu tahap 4, seperti di pipeline: extractDate menerima teks yang sudah dinormalisasi. */
async function dateOf(raw: string, now: Date = NOW) {
  const { text } = await parser.normalize(raw);
  return parser.extractDate(text, now);
}

const on = (date: string) => ({ status: 'found', date });
const rejected = (reason: string) => ({ status: 'rejected', reason });

describe('tanggal: tanpa penyebutan dan penanda hari ini', () => {
  it.each([
    ['tanpa penyebutan sama sekali', 'makan siang 25rb'],
    ['tanpa penyebutan, hanya nominal', '100rb'],
    ['tadi', 'tadi makan siang 25rb'],
    ['barusan', 'barusan beli kopi 18rb'],
    ['tadi pagi', 'tadi pagi sarapan 15rb'],
    ['tadi siang', 'tadi siang makan 25rb'],
    ['tadi sore', 'tadi sore ngopi 30rb'],
    ['hari ini', 'hari ini bayar listrik 350rb'],
    ['huruf besar', 'TADI PAGI SARAPAN 15RB'],
  ])('%s -> hari ini', async (_name, raw) => {
    expect(await dateOf(raw)).toMatchObject(on('2026-09-30'));
  });

  it('tanpa penyebutan: tidak ada potongan teks yang dikonsumsi', async () => {
    expect(await dateOf('makan siang 25rb')).toMatchObject({ status: 'found', matched: '' });
  });
});

describe('tanggal: relatif ke belakang', () => {
  it.each([
    ['kemarin', 'kemarin makan 25rb', '2026-09-29'],
    ['kemarin di akhir kalimat', 'makan 25rb kemarin', '2026-09-29'],
    ['KEMARIN huruf besar', 'KEMARIN MAKAN 25RB', '2026-09-29'],
    ['kemarin lusa (BUKAN sekadar kemarin)', 'kemarin lusa makan 25rb', '2026-09-28'],
    ['2 hari lalu', 'makan 25rb 2 hari lalu', '2026-09-28'],
    ['3 hari lalu', '3 hari lalu beli kopi 18rb', '2026-09-27'],
    ['7 hari lalu', 'bayar kos 7 hari lalu 800rb', '2026-09-23'],
  ])('%s', async (_name, raw, expected) => {
    expect(await dateOf(raw)).toMatchObject(on(expected));
  });
});

describe('tanggal: "tadi malam" dan aturan pukul 00.00-04.00 (Bagian 7)', () => {
  it.each([
    ['01.00 (kasus di spesifikasi)', 'tadi malam makan 25rb', '2026-10-01', 1, 0, '2026-09-30'],
    ['00.00 tepat', 'tadi malam makan 25rb', '2026-10-01', 0, 0, '2026-09-30'],
    ['03.59', 'tadi malam makan 25rb', '2026-10-01', 3, 59, '2026-09-30'],
    ['malam tadi, pukul 02.30', 'malam tadi nonton 50rb', '2026-10-01', 2, 30, '2026-09-30'],
    ['huruf besar, pukul 01.00', 'TADI MALAM MAKAN 25RB', '2026-10-01', 1, 0, '2026-09-30'],
  ])('dikirim %s -> hari sebelumnya', async (_name, raw, day, hour, minute, expected) => {
    expect(await dateOf(raw, wib(day, hour, minute))).toMatchObject(on(expected));
  });

  it.each([
    ['pukul 12.00', 12, 0],
    ['pukul 21.00', 21, 0],
    ['pukul 23.30', 23, 30],
  ])('dikirim %s -> hari ini (aturan 00.00-04.00 tidak berlaku)', async (_name, hour, minute) => {
    expect(await dateOf('tadi malam makan 25rb', wib('2026-09-30', hour, minute))).toMatchObject(on('2026-09-30'));
  });

  it('aturan jam hanya untuk penanda malam: "tadi pagi" pukul 01.00 tidak dimundurkan', async () => {
    expect(await dateOf('tadi pagi sarapan 15rb', wib('2026-10-01', 1, 0))).toMatchObject(on('2026-10-01'));
  });

  it('tanpa penyebutan pukul 01.00 tetap hari ini (aturan hanya berlaku bila ada penanda malam)', async () => {
    expect(await dateOf('makan 25rb', wib('2026-10-01', 1, 0))).toMatchObject(on('2026-10-01'));
  });
});

describe('tanggal: nama hari ("senin kemarin" = hari itu yang terakhir sudah lewat)', () => {
  // Hari ini Rabu 2026-09-30.
  it.each([
    ['senin kemarin', 'senin kemarin makan 25rb', '2026-09-28'],
    ['selasa kemarin', 'selasa kemarin makan 25rb', '2026-09-29'],
    ['kamis kemarin', 'kamis kemarin makan 25rb', '2026-09-24'],
    ['jumat kemarin', 'jumat kemarin makan 25rb', '2026-09-25'],
    ['sabtu kemarin', 'sabtu kemarin makan 25rb', '2026-09-26'],
    ['SENIN KEMARIN huruf besar', 'SENIN KEMARIN MAKAN 25RB', '2026-09-28'],
  ])('hari ini Rabu: %s', async (_name, raw, expected) => {
    expect(await dateOf(raw)).toMatchObject(on(expected));
  });

  it('nama hari yang sama dengan hari ini berarti pekan lalu, bukan hari ini (Rabu, "rabu kemarin")', async () => {
    expect(await dateOf('rabu kemarin makan 25rb')).toMatchObject(on('2026-09-23'));
  });

  it('hari ini Senin: "senin kemarin" adalah Senin pekan lalu, bukan hari ini', async () => {
    expect(await dateOf('senin kemarin makan 25rb', wib('2026-10-05'))).toMatchObject(on('2026-09-28'));
  });

  it('lintas pergantian tahun: Jumat 2027-01-01, "senin kemarin" -> 2026-12-28', async () => {
    expect(await dateOf('senin kemarin makan 25rb', wib('2027-01-01'))).toMatchObject(on('2026-12-28'));
  });
});

describe('tanggal: tanggal absolut', () => {
  it.each([
    ['tanggal 25', 'tanggal 25 makan 30rb', '2026-09-25'],
    ['tanggal satu digit', 'tanggal 3 bayar kos 800rb', '2026-09-03'],
    ['tanggal 1', 'tanggal 1 bayar listrik 350rb', '2026-09-01'],
    ['tanggal hari ini sendiri', 'tanggal 30 makan 30rb', '2026-09-30'],
    ['25 sep', '25 sep makan 30rb', '2026-09-25'],
    ['25 september', '25 september makan 30rb', '2026-09-25'],
    ['25 SEP huruf besar', '25 SEP MAKAN 30RB', '2026-09-25'],
    ['bulan lain yang sudah lewat', '15 agustus bayar kos 800rb', '2026-08-15'],
    ['akhir Februari', '28 feb bayar listrik 350rb', '2026-02-28'],
  ])('%s', async (_name, raw, expected) => {
    expect(await dateOf(raw)).toMatchObject(on(expected));
  });

  it('29 Februari sah di tahun kabisat', async () => {
    expect(await dateOf('29 feb makan 30rb', wib('2028-03-01'))).toMatchObject(on('2028-02-29'));
  });

  it('"tanggal N" di bulan berjalan yang belum tiba ditolak sebagai masa depan (Bagian 7: bulan berjalan)', async () => {
    // Hari ini Senin 2026-10-05; tanggal 25 Oktober belum tiba.
    expect(await dateOf('tanggal 25 makan 30rb', wib('2026-10-05'))).toMatchObject(rejected('future'));
  });
});

describe('tanggal: ditolak karena tidak valid', () => {
  it.each([
    ['tanggal 30 februari (Bagian 17)', 'tanggal 30 februari makan 25rb'],
    ['31 September (bulan 30 hari)', '31 sep makan 25rb'],
    ['tanggal 31 di bulan 30 hari', 'tanggal 31 makan 25rb'],
    ['tanggal 0', 'tanggal 0 makan 25rb'],
    ['tanggal 32', 'tanggal 32 makan 25rb'],
    ['29 Februari di tahun biasa (2026)', '29 feb makan 25rb'],
  ])('%s -> invalid_date', async (_name, raw) => {
    expect(await dateOf(raw)).toMatchObject(rejected('invalid_date'));
  });
});

describe('tanggal: ditolak karena masa depan', () => {
  it.each([
    ['besok (Bagian 17)', 'besok makan 25 ribu'],
    ['lusa', 'lusa bayar listrik 350rb'],
    ['minggu depan', 'minggu depan bayar kos 800rb'],
    ['bulan depan', 'bulan depan bayar cicilan 1jt'],
    ['2 hari lagi', '2 hari lagi bayar kos 800rb'],
    ['besok huruf besar', 'BESOK MAKAN 25RB'],
    ['tanggal bulan depan, 1 Oktober', '1 oktober bayar kos 800rb'],
  ])('%s -> future', async (_name, raw) => {
    expect(await dateOf(raw)).toMatchObject(rejected('future'));
  });
});

describe('tanggal: ditolak karena terlalu kabur', () => {
  it.each([
    ['minggu lalu (spesifikasi)', 'minggu lalu makan 25rb'],
    ['bulan lalu', 'bulan lalu bayar kos 800rb'],
    ['beberapa hari lalu', 'beberapa hari lalu beli sepatu 300rb'],
    ['minggu lalu huruf besar', 'MINGGU LALU MAKAN 25RB'],
  ])('%s -> too_vague', async (_name, raw) => {
    expect(await dateOf(raw)).toMatchObject(rejected('too_vague'));
  });
});

describe('tanggal: ditolak karena lebih dari satu tahun ke belakang', () => {
  it.each([
    ['tahun lalu (Bagian 17)', 'tahun lalu beli laptop 8jt'],
    ['setahun lalu', 'setahun lalu beli laptop 8jt'],
    ['2 tahun lalu', '2 tahun lalu beli laptop 8jt'],
    ['tanggal bertahun, sehari melewati batas', '29 september 2025 beli laptop 8jt'],
    ['tanggal bertahun, jauh', '25 sep 2024 beli laptop 8jt'],
  ])('%s -> too_old', async (_name, raw) => {
    expect(await dateOf(raw)).toMatchObject(rejected('too_old'));
  });

  it('tepat satu tahun ke belakang masih sah (2026-09-30 -> 2025-09-30)', async () => {
    expect(await dateOf('30 september 2025 beli laptop 8jt')).toMatchObject(on('2025-09-30'));
  });
});

describe('tanggal: zona waktu Asia/Jakarta, bukan UTC (Bagian 17: "perhitungan memakai Asia/Jakarta secara eksplisit")', () => {
  // 20.00 UTC tanggal 30 sama dengan 03.00 WIB tanggal 1 berikutnya.
  const lateUtc = new Date('2026-09-30T20:00:00Z');

  it('instan 20.00 UTC: hari ini di Jakarta adalah 1 Oktober', async () => {
    expect(await dateOf('makan 25rb', lateUtc)).toMatchObject(on('2026-10-01'));
  });

  it('instan 20.00 UTC: kemarin adalah 30 September', async () => {
    expect(await dateOf('kemarin makan 25rb', lateUtc)).toMatchObject(on('2026-09-30'));
  });

  it('instan 20.00 UTC = 03.00 WIB: "tadi malam" dimundurkan ke 30 September', async () => {
    expect(await dateOf('tadi malam makan 25rb', lateUtc)).toMatchObject(on('2026-09-30'));
  });

  it('pergantian tahun: 17.30 UTC 31 Des adalah 00.30 WIB 1 Jan, dan kemarin adalah 31 Des', async () => {
    const newYear = new Date('2026-12-31T17:30:00Z');
    expect(await dateOf('makan 25rb', newYear)).toMatchObject(on('2027-01-01'));
    expect(await dateOf('kemarin makan 25rb', newYear)).toMatchObject(on('2026-12-31'));
  });

  it.each([
    ['pergantian bulan: 1 Oktober, kemarin', 'kemarin makan 25rb', '2026-10-01', '2026-09-30'],
    ['pergantian bulan: 1 Oktober, 2 hari lalu', '2 hari lalu makan 25rb', '2026-10-01', '2026-09-29'],
    ['pergantian tahun: 1 Januari, kemarin', 'kemarin makan 25rb', '2027-01-01', '2026-12-31'],
    ['tahun kabisat: 1 Maret 2028, kemarin', 'kemarin makan 25rb', '2028-03-01', '2028-02-29'],
    ['tahun biasa: 1 Maret 2027, kemarin', 'kemarin makan 25rb', '2027-03-01', '2027-02-28'],
  ])('%s', async (_name, raw, today, expected) => {
    expect(await dateOf(raw, wib(today))).toMatchObject(on(expected));
  });
});

describe('tanggal: sifat umum', () => {
  it.each(['makan 25rb', 'kemarin makan 25rb', 'senin kemarin makan 25rb', '25 sep makan 25rb', 'tadi malam makan 25rb'])(
    'tanggal yang ditemukan selalu berformat YYYY-MM-DD: %s',
    async (raw) => {
      const result = await dateOf(raw);
      expect(result.status).toBe('found');
      if (result.status === 'found') expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
  );

  it('murni: bergantung pada `now` yang diberikan, bukan jam sistem', async () => {
    expect(await dateOf('makan 25rb', wib('2020-02-29'))).toMatchObject(on('2020-02-29'));
    expect(await dateOf('makan 25rb', wib('2031-12-31'))).toMatchObject(on('2031-12-31'));
  });
});
