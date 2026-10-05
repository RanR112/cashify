// Orkestrator `parseMessage`: seluruh pipeline dari pesan mentah sampai hasil (ARCHITECTURE.md
// Bagian 6, 7, dan 17). Di sini diuji perilaku ujung ke ujung dan interaksi antartahap; kasus per
// tahap ada di berkas lain. Prinsip yang diuji: nominal tidak jelas -> bertanya, tidak menebak;
// kategori tidak jelas -> bertanya; tanggal buruk -> ditolak dengan alasan.
// Semua test di berkas ini harus GAGAL sampai P14 menulis src/parsers/index.ts.
//
// Acuan: NOW = Rabu 2026-09-30 12.00 WIB.

import { describe, expect, it } from 'vitest';
import { DICTIONARY, NOW, parser, wib, withoutOriginal } from './helpers.js';

const TODAY = '2026-09-30';

describe('parseMessage: transaksi siap dikonfirmasi (ready)', () => {
  it.each([
    // Contoh bahasa alami Bagian 6
    ['tadi makan siang 25 ribu', { type: 'expense', amount: 25_000, date: TODAY, categorySlug: 'food' }],
    ['beli kopi 18rb', { type: 'expense', amount: 18_000, date: TODAY, categorySlug: 'food' }],
    ['bayar listrik 350.000', { type: 'expense', amount: 350_000, date: TODAY, categorySlug: 'bills' }],
    ['gaji bulan ini 5 juta', { type: 'income', amount: 5_000_000, date: TODAY, categorySlug: 'salary' }],
    ['isi bensin 50k', { type: 'expense', amount: 50_000, date: TODAY, categorySlug: 'transport' }],
    // Bagian 17
    ['belanja 100 ribu', { type: 'expense', amount: 100_000, date: TODAY, categorySlug: 'shopping' }],
    ['beli 3 kopi 54 ribu', { type: 'expense', amount: 54_000, date: TODAY, categorySlug: 'food' }],
    ['beli 2 kopi 36rb', { type: 'expense', amount: 36_000, date: TODAY, categorySlug: 'food' }],
    ['makan 25.5 ribu', { type: 'expense', amount: 25_500, date: TODAY, categorySlug: 'food' }],
    ['beli baju 1.000.000', { type: 'expense', amount: 1_000_000, categorySlug: 'shopping' }],
    ['beli baju 1,000,000', { type: 'expense', amount: 1_000_000, categorySlug: 'shopping' }],
    // Pemasukan
    ['thr 1jt', { type: 'income', amount: 1_000_000, categorySlug: 'bonus' }],
    ['dapat bonus 500rb', { type: 'income', amount: 500_000, categorySlug: 'bonus' }],
    ['fee desain 500rb', { type: 'income', amount: 500_000, categorySlug: 'freelance' }],
    // Tanggal
    ['kemarin makan 25rb', { amount: 25_000, date: '2026-09-29', categorySlug: 'food' }],
    ['kemarin lusa makan 25rb', { amount: 25_000, date: '2026-09-28', categorySlug: 'food' }],
    ['senin kemarin makan siang 25rb', { amount: 25_000, date: '2026-09-28', categorySlug: 'food' }],
    ['makan 25rb 3 hari lalu', { amount: 25_000, date: '2026-09-27', categorySlug: 'food' }],
  ])('"%s"', async (raw, expected) => {
    expect(await parser.parseMessage(raw)).toMatchObject({
      outcome: 'ready',
      intent: 'CREATE_TRANSACTION',
      ...expected,
    });
  });

  it('semua nominal yang siap disimpan adalah bilangan bulat positif (aturan 1)', async () => {
    for (const raw of ['makan 25.5 ribu', 'beli kopi 1,5k', 'beli makan 20', 'gaji 1,5jt', 'beli baju 0,5 juta']) {
      const result = await parser.parseMessage(raw);
      if (result.outcome === 'ready') {
        expect(Number.isInteger(result.amount)).toBe(true);
        expect(result.amount).toBeGreaterThan(0);
      }
    }
  });
});

describe('parseMessage: tebakan yang harus tampak di konfirmasi (assumptions)', () => {
  it('"beli makan 20" -> Rp20.000 dan ditandai sebagai ribuan yang diasumsikan', async () => {
    expect(await parser.parseMessage('beli makan 20')).toMatchObject({
      outcome: 'ready',
      type: 'expense',
      amount: 20_000,
      categorySlug: 'food',
      assumptions: ['amount_in_thousands'],
    });
  });

  it.each(['tadi makan siang 25 ribu', 'beli 3 kopi 54 ribu', 'bayar listrik 350.000', 'beli pulpen 1500'])(
    'nominal yang tertulis jelas tidak ditandai sebagai tebakan: "%s"',
    async (raw) => {
      expect(await parser.parseMessage(raw)).toMatchObject({ outcome: 'ready', assumptions: [] });
    },
  );
});

describe('parseMessage: command eksplisit', () => {
  it('/keluar 25000 makanan', async () => {
    expect(await parser.parseMessage('/keluar 25000 makanan')).toMatchObject({
      outcome: 'ready',
      intent: 'CREATE_TRANSACTION',
      type: 'expense',
      amount: 25_000,
      date: TODAY,
      categorySlug: 'food',
    });
  });

  it('/masuk 5000000 gaji gaji september: kategori gaji, catatan "gaji september"', async () => {
    expect(await parser.parseMessage('/masuk 5000000 gaji gaji september')).toMatchObject({
      outcome: 'ready',
      type: 'income',
      amount: 5_000_000,
      categorySlug: 'salary',
      description: 'gaji september',
    });
  });

  it('/keluar 25rb makanan makan siang: catatan "makan siang"', async () => {
    expect(await parser.parseMessage('/keluar 25rb makanan makan siang')).toMatchObject({
      outcome: 'ready',
      type: 'expense',
      amount: 25_000,
      categorySlug: 'food',
      description: 'makan siang',
    });
  });

  it('/KELUAR 25000 MAKANAN huruf besar sama dengan huruf kecil', async () => {
    const upper = await parser.parseMessage('/KELUAR 25000 MAKANAN');
    const lower = await parser.parseMessage('/keluar 25000 makanan');
    expect(withoutOriginal(upper)).toEqual(withoutOriginal(lower));
  });

  it.each([
    ['/keluar tanpa nominal: nominal wajib, bertanya', '/keluar', 'expense'],
    ['/masuk tanpa nominal: bertanya', '/masuk', 'income'],
    ['/keluar dengan kategori tetapi tanpa nominal', '/keluar makanan', 'expense'],
  ] as const)('%s', async (_name, raw, type) => {
    expect(await parser.parseMessage(raw)).toMatchObject({ outcome: 'clarify', ask: 'amount', type });
  });

  it.each([
    ['/keluar nominal negatif', '/keluar -25000 makanan', 'amount_negative'],
    ['/keluar nominal nol', '/keluar 0 makanan', 'amount_zero'],
    ['/keluar nominal absurd', '/keluar 999999999999 makanan', 'amount_too_large'],
  ])('%s -> rejected', async (_name, raw, reason) => {
    expect(await parser.parseMessage(raw)).toMatchObject({ outcome: 'rejected', reason });
  });

  it('command nominal ambigu untuk pemasukan: bertanya, tidak menebak', async () => {
    expect(await parser.parseMessage('/masuk 5 gaji')).toMatchObject({ outcome: 'clarify', ask: 'amount', type: 'income' });
  });
});

describe('parseMessage: nominal ambigu dibawa agar balasan bisa bertanya "5 ribu atau 5 juta?"', () => {
  it('pemasukan telanjang membawa ambiguousAmount, tetapi bukan amount', async () => {
    const result = await parser.parseMessage('gaji 5');
    expect(result).toMatchObject({ outcome: 'clarify', ask: 'amount', type: 'income', ambiguousAmount: 5 });
    expect(result).not.toHaveProperty('amount');
  });

  it('nominal yang memang tidak ada tidak membawa ambiguousAmount', async () => {
    expect(await parser.parseMessage('bayar listrik')).not.toHaveProperty('ambiguousAmount');
  });
});

describe('parseMessage: nominal atau kategori tidak lengkap -> bertanya (Bagian 17)', () => {
  it.each([
    ['gaji 5 (pemasukan di bawah 1.000, tidak ditebak)', 'gaji 5', { type: 'income', categorySlug: 'salary' }],
    ['gaji 500', 'gaji 500', { type: 'income', categorySlug: 'salary' }],
    ['bayar listrik (kategori terdeteksi, nominal kosong: tanya nominal saja)', 'bayar listrik', { type: 'expense', categorySlug: 'bills' }],
    ['tadi beli sesuatu (tidak ada nominal)', 'tadi beli sesuatu', { type: 'expense', categorySlug: 'shopping' }],
  ])('%s', async (_name, raw, expected) => {
    const result = await parser.parseMessage(raw);
    expect(result).toMatchObject({ outcome: 'clarify', intent: 'CREATE_TRANSACTION', ask: 'amount', ...expected });
    expect(result).not.toHaveProperty('amount'); // tidak ada nominal yang ditebak
  });

  it.each([
    ['keluar 50 ribu (spesifikasi): nominal ada, kategori kabur', 'keluar 50 ribu', 50_000, 'expense'],
    ['100rb: hanya nominal, asumsikan pengeluaran', '100rb', 100_000, 'expense'],
    ['dapat 200rb: pemasukan tanpa kategori', 'dapat 200rb', 200_000, 'income'],
    ['transfer 100 rb ke 2 orang: dua angka, nominal dari sufiks', 'transfer 100 rb ke 2 orang', 100_000, 'expense'],
    ['gopay 20rb: singkatan dompet digital tanpa kategori', 'gopay 20rb', 20_000, 'expense'],
  ])('%s', async (_name, raw, amount, type) => {
    expect(await parser.parseMessage(raw)).toMatchObject({
      outcome: 'clarify',
      intent: 'CREATE_TRANSACTION',
      ask: 'category',
      type,
      amount,
    });
  });

  it('"tuku sego 15ewu" (bahasa daerah, tidak didukung): tidak pernah langsung siap disimpan', async () => {
    const result = await parser.parseMessage('tuku sego 15ewu');
    expect(result.outcome).not.toBe('ready');
    expect(result.outcome).toBe('clarify');
  });

  it('klarifikasi tetap membawa tanggal yang sudah dipahami', async () => {
    expect(await parser.parseMessage('kemarin keluar 50 ribu')).toMatchObject({
      outcome: 'clarify',
      ask: 'category',
      date: '2026-09-29',
      amount: 50_000,
    });
  });
});

describe('parseMessage: penolakan dengan alasan', () => {
  it.each([
    ['makan 999999999999', 'amount_too_large'],
    ['makan 1000000001', 'amount_too_large'],
    ['beli baju -50000', 'amount_negative'],
    ['beli baju -50rb', 'amount_negative'],
    ['beli 0', 'amount_zero'],
    ['beli rp0', 'amount_zero'],
    ['besok makan 25 ribu', 'date_future'],
    ['lusa bayar listrik 350rb', 'date_future'],
    ['minggu lalu makan 25rb', 'date_too_vague'],
    ['bulan lalu bayar kos 800rb', 'date_too_vague'],
    ['tahun lalu beli laptop 8jt', 'date_too_old'],
    ['tanggal 30 februari makan 25rb', 'date_invalid'],
    ['31 sep makan 25rb', 'date_invalid'],
  ])('"%s" -> rejected: %s', async (raw, reason) => {
    expect(await parser.parseMessage(raw)).toMatchObject({
      outcome: 'rejected',
      intent: 'CREATE_TRANSACTION',
      reason,
    });
  });

  it('nominal sah tidak menyelamatkan tanggal yang ditolak: tidak ada hasil siap simpan', async () => {
    const result = await parser.parseMessage('besok makan 25 ribu');
    expect(result).not.toHaveProperty('amount');
    expect(result.outcome).toBe('rejected');
  });

  it('batas Rp1 miliar: tepat 1.000.000.000 lolos', async () => {
    expect(await parser.parseMessage('beli tanah 1.000.000.000')).toMatchObject({
      outcome: 'ready',
      amount: 1_000_000_000,
    });
  });
});

describe('parseMessage: intent selain membuat transaksi', () => {
  it.each([
    ['ya', 'CONFIRM'],
    ['y', 'CONFIRM'],
    ['ok', 'CONFIRM'],
    ['iya', 'CONFIRM'],
    ['betul', 'CONFIRM'],
    ['batal', 'CANCEL'],
    ['no', 'CANCEL'],
    ['n', 'CANCEL'],
    ['gajadi', 'CANCEL'],
    ['salah', 'CANCEL'],
    ['hapus transaksi terakhir', 'DELETE'],
    ['/hapus', 'DELETE'],
    ['/help', 'HELP'],
    ['bantuan', 'HELP'],
    ['/saldo', 'QUERY'],
    ['pengeluaran bulan ini berapa?', 'QUERY'],
    ['/foo', 'UNKNOWN'],
    ['halo apa kabar', 'UNKNOWN'],
  ])('"%s" -> %s', async (raw, intent) => {
    expect(await parser.parseMessage(raw)).toMatchObject({ outcome: 'intent', intent });
  });

  it('"ubah jadi 35 ribu" -> CORRECT dengan nominal baru', async () => {
    expect(await parser.parseMessage('ubah jadi 35 ribu')).toMatchObject({
      outcome: 'intent',
      intent: 'CORRECT',
      amount: 35_000,
    });
  });

  it.each([
    ['makanan', 'category'],
    ['2', 'category'],
    ['25rb', 'amount'],
  ] as const)('"%s" saat menunggu %s -> CLARIFY_RESPONSE', async (raw, awaiting) => {
    expect(await parser.parseMessage(raw, { awaiting })).toMatchObject({ outcome: 'intent', intent: 'CLARIFY_RESPONSE' });
  });

  it('hasil intent tidak membawa field transaksi', async () => {
    const result = await parser.parseMessage('ya');
    expect(result).not.toHaveProperty('categorySlug');
    expect(result).not.toHaveProperty('date');
  });
});

describe('parseMessage: pesan kosong diabaikan (tidak dibalas)', () => {
  it.each([
    ['string kosong', ''],
    ['hanya spasi', '   '],
    ['hanya baris baru', '\n\n'],
    ['hanya emoji', '🍔'],
    ['hanya NBSP', ' '],
  ])('%s', async (_name, raw) => {
    expect(await parser.parseMessage(raw)).toEqual({ outcome: 'ignored', original: raw });
  });
});

describe('parseMessage: bahasa dan penulisan (Bagian 17)', () => {
  it.each([
    ['MAKAN SIANG 25 RIBU', 'makan siang 25 ribu'],
    ['Makan Siang 25 Ribu', 'makan siang 25 ribu'],
    ['tadi MAKAN siang 25RB', 'tadi makan siang 25rb'],
    ['  makan   siang   25 ribu  ', 'makan siang 25 ribu'],
    ['BELI KOPI 18RB', 'beli kopi 18rb'],
    ['GAJI BULAN INI 5 JUTA', 'gaji bulan ini 5 juta'],
  ])('huruf besar/spasi: "%s" sama dengan "%s"', async (variant, base) => {
    const a = await parser.parseMessage(variant);
    const b = await parser.parseMessage(base);
    expect(withoutOriginal(a)).toEqual(withoutOriginal(b));
    expect(a.original).toBe(variant); // teks asli tetap yang diterima
  });

  it('MAKAN SIANG 25 RIBU -> makanan, Rp25.000 (kasus spesifikasi)', async () => {
    expect(await parser.parseMessage('MAKAN SIANG 25 RIBU')).toMatchObject({
      outcome: 'ready',
      amount: 25_000,
      categorySlug: 'food',
    });
  });

  // Tiga kasus berikut baru hijau setelah P14 menambah varian ke kamus seed (prisma/seed-data.ts).
  it.each([
    ['typo: mkn siang 25rb', 'mkn siang 25rb', 25_000],
    ['campur bahasa: lunch 25 ribu', 'lunch 25 ribu', 25_000],
    ['campur bahasa: beli coffee 18k', 'beli coffee 18k', 18_000],
  ])('%s -> makanan', async (_name, raw, amount) => {
    expect(await parser.parseMessage(raw)).toMatchObject({
      outcome: 'ready',
      type: 'expense',
      amount,
      categorySlug: 'food',
    });
  });

  it('emoji dihapus saat normalisasi tetapi disimpan di teks asli: "🍔 25rb"', async () => {
    const result = await parser.parseMessage('🍔 25rb');
    expect(result.original).toBe('🍔 25rb');
    expect(result).toMatchObject({ outcome: 'clarify', ask: 'category', amount: 25_000 });
    expect(JSON.stringify(withoutOriginal(result))).not.toContain('🍔');
  });

  it('emoji di antara kata tidak mengganggu: "makan 🍔 siang 25rb"', async () => {
    expect(await parser.parseMessage('makan 🍔 siang 25rb')).toMatchObject({
      outcome: 'ready',
      amount: 25_000,
      categorySlug: 'food',
      description: 'makan siang',
    });
  });

  it('pesan sangat panjang (500+ karakter) tetap terparse; catatan dipotong, teks asli utuh', async () => {
    const raw = `makan siang 25rb ${'enak '.repeat(100)}`;
    expect(raw.length).toBeGreaterThan(500);
    const result = await parser.parseMessage(raw);
    expect(result).toMatchObject({ outcome: 'ready', amount: 25_000, categorySlug: 'food' });
    if (result.outcome === 'ready') expect(result.description.length).toBeLessThanOrEqual(255);
    expect(result.original).toBe(raw);
  });
});

describe('parseMessage: deskripsi (teks tanpa nominal dan penanda tanggal)', () => {
  it.each([
    ['tadi makan siang 25 ribu', 'makan siang'], // contoh konfirmasi Bagian 6: "makan siang"
    ['MAKAN SIANG 25 RIBU', 'makan siang'],
    ['kemarin makan 25rb', 'makan'],
    ['beli kopi 18rb', 'beli kopi'],
    ['bayar listrik 350.000', 'bayar listrik'],
    ['25rb makan siang', 'makan siang'],
    ['senin kemarin makan siang 25rb', 'makan siang'],
    ['isi bensin 50k', 'isi bensin'],
  ])('"%s" -> "%s"', async (raw, description) => {
    expect(await parser.parseMessage(raw)).toMatchObject({ description });
  });
});

describe('parseMessage: angka penanda tanggal tidak terbaca sebagai nominal', () => {
  it.each([
    ['tanggal 25 makan 30rb', 30_000, '2026-09-25'],
    ['25 sep makan 30rb', 30_000, '2026-09-25'],
    ['2 hari lalu makan 25rb', 25_000, '2026-09-28'],
    ['3 hari lalu beli kopi 18rb', 18_000, '2026-09-27'],
    ['makan 30rb tanggal 25', 30_000, '2026-09-25'],
    ['tanggal 3 bayar kos 800rb', 800_000, '2026-09-03'],
  ])('"%s" -> nominal %i, tanggal %s', async (raw, amount, date) => {
    expect(await parser.parseMessage(raw)).toMatchObject({ outcome: 'ready', amount, date });
  });

  it('"tadi malam" pukul 01.00 mundur sehari (dan tetap membaca nominalnya)', async () => {
    expect(await parser.parseMessage('tadi malam makan 25rb', { now: wib('2026-10-01', 1, 0) })).toMatchObject({
      outcome: 'ready',
      amount: 25_000,
      date: '2026-09-30',
    });
  });

  it('tanggal dihitung dari `now` konteks di zona Jakarta: 20.00 UTC = 03.00 WIB hari berikutnya', async () => {
    expect(await parser.parseMessage('makan 25rb', { now: new Date('2026-09-30T20:00:00Z') })).toMatchObject({
      outcome: 'ready',
      date: '2026-10-01',
    });
  });
});

describe('parseMessage: sifat umum', () => {
  it('murni: pesan dan konteks yang sama selalu menghasilkan hasil yang sama', async () => {
    for (const raw of ['tadi makan siang 25 ribu', 'gaji 5', 'besok makan 25rb', 'ya', '/keluar 25000 makanan']) {
      expect(await parser.parseMessage(raw)).toEqual(await parser.parseMessage(raw));
    }
  });

  it('bergantung pada `now` konteks, bukan jam sistem', async () => {
    expect(await parser.parseMessage('makan 25rb', { now: wib('2020-02-29') })).toMatchObject({ date: '2020-02-29' });
    expect(await parser.parseMessage('makan 25rb', { now: wib('2031-12-31') })).toMatchObject({ date: '2031-12-31' });
  });

  it('tidak mengubah kamus maupun `now` yang diberikan', async () => {
    const dictionaryBefore = JSON.stringify(DICTIONARY);
    const now = new Date(NOW.getTime());
    await parser.parseMessage('tadi makan siang 25 ribu', { now });
    expect(JSON.stringify(DICTIONARY)).toBe(dictionaryBefore);
    expect(now.getTime()).toBe(NOW.getTime());
  });

  it('kamus kustom mengubah kategori: kamus adalah argumen, bukan data tertanam', async () => {
    const pets = [{ slug: 'pets', name: 'Hewan', type: 'expense' as const, keywords: ['kucing'] }];
    expect(await parser.parseMessage('beli pasir kucing 50rb', { categories: pets })).toMatchObject({
      outcome: 'ready',
      categorySlug: 'pets',
      amount: 50_000,
    });
    expect(await parser.parseMessage('makan siang 25rb', { categories: pets })).toMatchObject({
      outcome: 'clarify',
      ask: 'category',
    });
  });

  it('setiap hasil membawa teks asli persis seperti diterima', async () => {
    for (const raw of ['  Tadi MAKAN 25rb ', '🍔 25rb', 'ya', 'gaji 5', 'besok makan 25rb', '/foo']) {
      expect((await parser.parseMessage(raw)).original).toBe(raw);
    }
  });
});
