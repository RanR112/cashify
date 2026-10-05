// Tahap 6: validasi deterministik (ARCHITECTURE.md Bagian 7). Pemeriksaan terakhir sebelum
// transaksi dinyatakan siap dikonfirmasi.

import { describe, expect, it } from 'vitest';
import { limitDescription, validateDraft } from '../../../src/parsers/validate.js';

const TODAY = '2026-09-30';
const ok = { ok: true };
const check = (amount: number, date = TODAY) => validateDraft({ amount, date, today: TODAY });

describe('validateDraft: nominal', () => {
  it.each([1, 1000, 25_000, 1_000_000_000])('%i sah', (amount) => {
    expect(check(amount)).toEqual(ok);
  });

  it('di atas Rp1 miliar ditolak', () => {
    expect(check(1_000_000_001)).toEqual({ ok: false, reason: 'amount_too_large' });
  });

  it('negatif ditolak', () => {
    expect(check(-1)).toEqual({ ok: false, reason: 'amount_negative' });
  });

  it.each([0, 1.5, Number.NaN])('%s ditolak, bukan bilangan bulat positif', (amount) => {
    expect(check(amount)).toEqual({ ok: false, reason: 'amount_zero' });
  });
});

describe('validateDraft: tanggal', () => {
  it.each([TODAY, '2026-09-29', '2025-09-30'])('%s sah', (date) => {
    expect(check(1000, date)).toEqual(ok);
  });

  it('besok ditolak', () => {
    expect(check(1000, '2026-10-01')).toEqual({ ok: false, reason: 'date_future' });
  });

  it('lebih dari satu tahun ke belakang ditolak', () => {
    expect(check(1000, '2025-09-29')).toEqual({ ok: false, reason: 'date_too_old' });
  });

  it.each(['2026-02-30', '2026-13-01', 'kemarin', ''])('"%s" bukan tanggal sah', (date) => {
    expect(check(1000, date)).toEqual({ ok: false, reason: 'date_invalid' });
  });
});

describe('limitDescription', () => {
  it('merapikan spasi', () => {
    expect(limitDescription('  makan   siang \n')).toBe('makan siang');
  });

  it('memotong sampai 255 karakter tanpa spasi di ujung', () => {
    const result = limitDescription(`${'a'.repeat(254)} bbbb`);
    expect(result.length).toBeLessThanOrEqual(255);
    expect(result).toBe('a'.repeat(254));
  });

  it('kosong tetap kosong', () => {
    expect(limitDescription('   ')).toBe('');
  });
});
