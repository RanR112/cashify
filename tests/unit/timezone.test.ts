import { describe, expect, it } from 'vitest';
import {
  addDays,
  currentMonthInJakarta,
  isValidDateString,
  jakartaDayStartUtc,
  jakartaHour,
  monthBounds,
  oneYearBefore,
  toJakartaDate,
  todayInJakarta,
} from '../../src/shared/utils/timezone.js';

describe('toJakartaDate / todayInJakarta', () => {
  it('batas hari ada di 17:00 UTC (00:00 WIB)', () => {
    expect(toJakartaDate(new Date('2026-09-28T16:59:59Z'))).toBe('2026-09-28');
    expect(toJakartaDate(new Date('2026-09-28T17:00:00Z'))).toBe('2026-09-29');
  });

  it('pergantian bulan', () => {
    expect(toJakartaDate(new Date('2026-09-30T17:00:00Z'))).toBe('2026-10-01');
  });

  it('pergantian tahun', () => {
    expect(toJakartaDate(new Date('2026-12-31T16:59:59Z'))).toBe('2026-12-31');
    expect(toJakartaDate(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01-01');
  });

  it('tanggal UTC dan WIB berbeda pada pukul 00.00-06.59 WIB', () => {
    // 2026-09-28 20:00 UTC = 2026-09-29 03:00 WIB
    expect(todayInJakarta(new Date('2026-09-28T20:00:00Z'))).toBe('2026-09-29');
  });

  it('29 Februari tahun kabisat', () => {
    expect(toJakartaDate(new Date('2028-02-28T17:00:00Z'))).toBe('2028-02-29');
    expect(toJakartaDate(new Date('2028-02-29T17:00:00Z'))).toBe('2028-03-01');
  });
});

describe('jakartaHour', () => {
  it.each([
    ['2026-09-28T16:59:59Z', 23],
    ['2026-09-28T17:00:00Z', 0],
    ['2026-09-28T18:00:00Z', 1],
    ['2026-09-28T20:00:00Z', 3],
    ['2026-09-28T21:00:00Z', 4],
    ['2026-09-28T05:12:35Z', 12],
  ])('%s -> jam %d WIB', (iso, hour) => {
    expect(jakartaHour(new Date(iso))).toBe(hour);
  });
});

describe('currentMonthInJakarta', () => {
  it('mengikuti bulan WIB, bukan UTC', () => {
    expect(currentMonthInJakarta(new Date('2026-09-30T16:59:59Z'))).toBe('2026-09');
    expect(currentMonthInJakarta(new Date('2026-09-30T17:00:00Z'))).toBe('2026-10');
  });
});

describe('isValidDateString', () => {
  it.each(['2026-09-28', '2028-02-29', '2026-12-31', '2026-01-01'])('sah: %s', (value) => {
    expect(isValidDateString(value)).toBe(true);
  });

  it.each([
    '2026-02-30',
    '2026-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-9-1',
    '28-09-2026',
    '2026-09-28T00:00:00Z',
    '',
  ])('tidak sah: %j', (value) => {
    expect(isValidDateString(value)).toBe(false);
  });
});

describe('addDays', () => {
  it.each([
    ['2026-09-28', 1, '2026-09-29'],
    ['2026-09-28', -1, '2026-09-27'],
    ['2026-09-30', 1, '2026-10-01'],
    ['2026-10-01', -1, '2026-09-30'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-09-28', 0, '2026-09-28'],
    ['2026-09-28', 365, '2027-09-28'],
  ])('%s %+d hari -> %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it('melempar untuk tanggal yang tidak ada', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
  });
});

describe('oneYearBefore', () => {
  it('mundur setahun', () => {
    expect(oneYearBefore('2026-09-28')).toBe('2025-09-28');
  });

  it('29 Februari menjadi 28 Februari', () => {
    expect(oneYearBefore('2028-02-29')).toBe('2027-02-28');
  });

  it('melempar untuk tanggal yang tidak ada', () => {
    expect(() => oneYearBefore('bukan-tanggal')).toThrow(RangeError);
  });
});

describe('monthBounds', () => {
  it.each([
    ['2026-09', '2026-09-01', '2026-09-30'],
    ['2026-10', '2026-10-01', '2026-10-31'],
    ['2026-02', '2026-02-01', '2026-02-28'],
    ['2028-02', '2028-02-01', '2028-02-29'],
    ['2026-12', '2026-12-01', '2026-12-31'],
    ['2026-01', '2026-01-01', '2026-01-31'],
  ])('%s', (month, from, to) => {
    expect(monthBounds(month)).toEqual({ from, to });
  });

  it.each(['2026-13', '2026-00', '2026-9', '202609', '2026-09-01', ''])('melempar untuk %j', (bad) => {
    expect(() => monthBounds(bad)).toThrow(RangeError);
  });
});

describe('jakartaDayStartUtc', () => {
  it('00:00 WIB = 17:00 UTC hari sebelumnya', () => {
    expect(jakartaDayStartUtc('2026-09-28').toISOString()).toBe('2026-09-27T17:00:00.000Z');
  });

  it('konsisten dengan toJakartaDate', () => {
    const start = jakartaDayStartUtc('2026-10-01');
    expect(toJakartaDate(start)).toBe('2026-10-01');
    expect(toJakartaDate(new Date(start.getTime() - 1))).toBe('2026-09-30');
  });

  it('melempar untuk tanggal yang tidak ada', () => {
    expect(() => jakartaDayStartUtc('2026-02-30')).toThrow(RangeError);
  });
});
