// Tahap 2: klasifikasi intent tingkat pertama, regex (ARCHITECTURE.md Bagian 6 dan 7). Sekitar 40%
// pesan nyata berhenti di sini dan tidak pernah menyentuh LLM. Pesan yang tidak diputuskan tahap
// ini jatuh ke tahap 3 (`via: 'fallthrough'`). Semua test di berkas ini harus GAGAL sampai P14
// menulis src/parsers/normalize.ts dan src/parsers/intent.ts.

import { describe, expect, it } from 'vitest';
import { parser } from './helpers.js';

describe('intent: CONFIRM', () => {
  it.each([
    ['ya', 'ya'],
    ['y', 'y'],
    ['ok', 'ok'],
    ['iya', 'iya'],
    ['betul', 'betul'],
    ['huruf besar: YA', 'YA'],
    ['huruf campur: Ya', 'Ya'],
    ['huruf besar: Y', 'Y'],
    ['huruf besar: OK', 'OK'],
    ['huruf campur: Iya', 'Iya'],
    ['huruf campur: Betul', 'Betul'],
    ['dengan tanda seru', 'ya!'],
    ['dengan titik', 'ya.'],
    ['dengan tanda seru berulang', 'ok!!'],
    ['dengan spasi di sekeliling', '  ok  '],
    ['dengan baris baru', 'iya\n'],
    ['dengan emoji (dibuang saat normalisasi)', '👍 ya'],
  ])('%s -> CONFIRM', async (_name, raw) => {
    expect(await parser.intent(raw)).toMatchObject({ intent: 'CONFIRM', via: 'keyword' });
  });
});

describe('intent: CANCEL', () => {
  it.each([
    ['batal', 'batal'],
    ['no', 'no'],
    ['n', 'n'],
    ['gajadi', 'gajadi'],
    ['salah', 'salah'],
    ['huruf besar: BATAL', 'BATAL'],
    ['huruf campur: No', 'No'],
    ['huruf besar: N', 'N'],
    ['huruf campur: Gajadi', 'Gajadi'],
    ['huruf campur: Salah', 'Salah'],
    ['dengan tanda seru', 'batal!'],
    ['dengan titik', 'salah.'],
    ['dengan spasi di sekeliling', '  gajadi  '],
  ])('%s -> CANCEL', async (_name, raw) => {
    expect(await parser.intent(raw)).toMatchObject({ intent: 'CANCEL', via: 'keyword' });
  });
});

describe('intent: kata konfirmasi/pembatalan hanya berlaku sebagai kata utuh', () => {
  it.each([
    ['"no" di awal kata: nonton', 'nonton 50rb'],
    ['"no" di awal kata: noodle', 'noodle 20rb'],
    ['"y" di awal kata: yoga', 'yoga 50 ribu'],
    ['"y" di awal kata: yakult', 'yakult 8rb'],
    ['"n" di awal kata: naik grab', 'naik grab 20rb'],
    ['"n" di awal kata: nasi uduk', 'nasi uduk 15rb'],
    ['"ok" di awal kata: okonomiyaki', 'okonomiyaki 85rb'],
    ['"ya" di awal kata: yadi', 'yadi bayar parkir 5rb'],
    ['"batal" di dalam kalimat transaksi', 'batal nonton, beli kopi 18rb'],
  ])('%s bukan CONFIRM/CANCEL', async (_name, raw) => {
    const result = await parser.intent(raw);
    expect(result.intent).not.toBe('CONFIRM');
    expect(result.intent).not.toBe('CANCEL');
    expect(result.via).toBe('fallthrough');
  });
});

describe('intent: explicit command (diparse murni dengan regex, tanpa LLM)', () => {
  it.each([
    ['/keluar dengan kategori (spesifikasi)', '/keluar 25000 makanan', 'keluar'],
    ['/masuk dengan kategori dan catatan', '/masuk 5000000 gaji gaji september', 'masuk'],
    ['/keluar dengan catatan', '/keluar 25000 makanan makan siang', 'keluar'],
    ['/keluar dengan sufiks rb', '/keluar 25rb makanan', 'keluar'],
    ['/KELUAR huruf besar', '/KELUAR 25rb', 'keluar'],
    ['/Masuk huruf campur', '/Masuk 5jt gaji', 'masuk'],
    ['/keluar dengan spasi di depan', '  /keluar 25000', 'keluar'],
    ['/keluar tanpa nominal (tetap command; kurangnya nominal ditangani tahap berikutnya)', '/keluar', 'keluar'],
    ['/keluar tanpa kategori', '/keluar 25000', 'keluar'],
  ])('%s -> CREATE_TRANSACTION', async (_name, raw, command) => {
    expect(await parser.intent(raw)).toMatchObject({ intent: 'CREATE_TRANSACTION', via: 'command', command });
  });

  it.each([
    ['/hapus', '/hapus', 'DELETE', 'hapus'],
    ['/saldo', '/saldo', 'QUERY', 'saldo'],
    ['/help', '/help', 'HELP', 'help'],
    ['/HELP huruf besar', '/HELP', 'HELP', 'help'],
    ['/Hapus huruf campur', '/Hapus', 'DELETE', 'hapus'],
  ])('%s -> %s', async (_name, raw, intent, command) => {
    expect(await parser.intent(raw)).toMatchObject({ intent, via: 'command', command });
  });

  it.each([
    ['command tidak dikenal', '/foo'],
    ['command tidak dikenal dengan argumen', '/transfer 25000 budi'],
    ['hanya garis miring', '/'],
  ])('%s -> UNKNOWN (balasan: contoh singkat)', async (_name, raw) => {
    expect(await parser.intent(raw)).toMatchObject({ intent: 'UNKNOWN', via: 'command', command: 'unknown' });
  });

  it.each([
    ['keluar tanpa garis miring', 'keluar 50 ribu'],
    ['masuk tanpa garis miring', 'masuk 5 juta gaji'],
    ['garis miring di tengah kalimat', 'beli ayam/bebek 50rb'],
  ])('tanpa "/" di awal BUKAN command: %s', async (_name, raw) => {
    expect(await parser.intent(raw)).toMatchObject({ via: 'fallthrough' });
  });
});

describe('intent: DELETE, HELP, QUERY, CORRECT lewat kata kunci', () => {
  it.each([
    ['hapus transaksi terakhir (spesifikasi)', 'hapus transaksi terakhir', 'DELETE'],
    ['HAPUS TRANSAKSI TERAKHIR huruf besar', 'HAPUS TRANSAKSI TERAKHIR', 'DELETE'],
    ['bantuan (spesifikasi)', 'bantuan', 'HELP'],
    ['BANTUAN huruf besar', 'BANTUAN', 'HELP'],
    ['apa aja yang bisa (contoh Bagian 6)', 'apa aja yang bisa', 'HELP'],
    ['pengeluaran bulan ini berapa? (contoh Bagian 6)', 'pengeluaran bulan ini berapa?', 'QUERY'],
    ['berapa pengeluaran bulan ini', 'berapa pengeluaran bulan ini', 'QUERY'],
    ['ubah jadi 35 ribu (contoh Bagian 6)', 'ubah jadi 35 ribu', 'CORRECT'],
    ['UBAH JADI 35RB huruf besar', 'UBAH JADI 35RB', 'CORRECT'],
  ])('%s', async (_name, raw, intent) => {
    expect(await parser.intent(raw)).toMatchObject({ intent, via: 'keyword' });
  });
});

describe('intent: pesan kosong diabaikan (Bagian 17: tidak dibalas)', () => {
  it.each([
    ['string kosong', ''],
    ['hanya spasi', '     '],
    ['hanya baris baru dan tab', '\n\t\r\n'],
    ['hanya NBSP', ' '],
    ['hanya emoji', '🍔'],
    ['emoji dan spasi', ' 👍 '],
  ])('%s -> IGNORED', async (_name, raw) => {
    expect((await parser.intent(raw)).intent).toBe('IGNORED');
  });
});

describe('intent: bahasa alami jatuh ke tahap berikutnya', () => {
  it.each([
    ['transaksi dengan nominal', 'tadi makan siang 25 ribu'],
    ['transaksi singkat', 'beli kopi 18rb'],
    ['tagihan', 'bayar listrik 350.000'],
    ['hanya nominal', '100rb'],
    ['tanpa nominal', 'bayar listrik'],
    ['huruf besar semua', 'MAKAN SIANG 25 RIBU'],
    ['sapaan yang tidak dikenal', 'halo apa kabar'],
    ['kata kategori tanpa pertanyaan yang menunggu', 'makanan'],
  ])('%s -> fallthrough, intent sementara UNKNOWN', async (_name, raw) => {
    expect(await parser.intent(raw)).toMatchObject({ intent: 'UNKNOWN', via: 'fallthrough' });
  });
});

describe('intent: CLARIFY_RESPONSE bergantung pada pertanyaan yang menunggu', () => {
  it.each([
    ['nama kategori', 'makanan', 'category'],
    ['nama kategori huruf besar', 'Makanan', 'category'],
    ['nomor pilihan', '2', 'category'],
    ['kategori lain', 'transportasi', 'category'],
    ['nominal dengan sufiks', '25rb', 'amount'],
    ['nominal polos', '25000', 'amount'],
    ['nominal dengan juta', '5 juta', 'amount'],
  ] as const)('%s dijawab saat menunggu %s -> CLARIFY_RESPONSE', async (_name, raw, awaiting) => {
    expect(await parser.intent(raw, { awaiting })).toMatchObject({ intent: 'CLARIFY_RESPONSE' });
  });

  it.each([
    ['transaksi baru lengkap saat menunggu kategori', 'tadi makan siang 25 ribu', 'category'],
    ['transaksi baru lengkap saat menunggu nominal', 'beli kopi 18rb', 'amount'],
    ['transaksi baru saat menunggu konfirmasi', 'beli kopi 18rb', 'confirmation'],
  ] as const)('%s bukan jawaban (pending lama diganti diam-diam)', async (_name, raw, awaiting) => {
    expect(await parser.intent(raw, { awaiting })).toMatchObject({ via: 'fallthrough' });
  });

  it.each([
    ['ya', 'confirmation', 'CONFIRM'],
    ['ok', 'confirmation', 'CONFIRM'],
    ['batal', 'confirmation', 'CANCEL'],
    ['batal', 'category', 'CANCEL'],
    ['batal', 'amount', 'CANCEL'],
    ['salah', 'category', 'CANCEL'],
    ['gajadi', 'amount', 'CANCEL'],
  ] as const)('"%s" saat menunggu %s -> %s (pembatalan selalu menang)', async (raw, awaiting, intent) => {
    expect(await parser.intent(raw, { awaiting })).toMatchObject({ intent });
  });

  it('"ya" tanpa pending tetap CONFIRM; balasan "tidak ada yang perlu dikonfirmasi" urusan alur percakapan', async () => {
    expect(await parser.intent('ya')).toMatchObject({ intent: 'CONFIRM' });
  });
});
