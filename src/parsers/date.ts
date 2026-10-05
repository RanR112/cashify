// Tahap 4: ekstraksi tanggal. REGEX SAJA, acuan zona Asia/Jakarta. Semua hitungan zona waktu
// lewat shared/utils/timezone.ts; waktu masuk lewat `now`, jam sistem tidak pernah dibaca.
// Tanggal masa depan, lebih dari satu tahun ke belakang, dan yang terlalu kabur ditolak.

import {
  addDays,
  isValidDateString,
  jakartaHour,
  oneYearBefore,
  toJakartaDate,
} from '../shared/utils/timezone.js';
import type { CalendarDate, DateRejectReason, DateResult } from './types.js';

const NOT_LETTER_OR_DIGIT_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_LETTER_OR_DIGIT_AFTER = '(?![\\p{L}\\p{N}])';

function phrase(source: string): RegExp {
  return new RegExp(`${NOT_LETTER_OR_DIGIT_BEFORE}(?:${source})${NOT_LETTER_OR_DIGIT_AFTER}`, 'u');
}

const MONTHS: Record<string, number> = {
  januari: 1, jan: 1,
  februari: 2, feb: 2,
  maret: 3, mar: 3,
  april: 4, apr: 4,
  mei: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  agustus: 8, agu: 8, agt: 8, ags: 8,
  september: 9, sept: 9, sep: 9,
  oktober: 10, okt: 10,
  november: 11, nov: 11,
  desember: 12, des: 12,
};
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

// Minggu = 0, seperti Date#getUTCDay.
const WEEKDAYS: Record<string, number> = {
  minggu: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6,
};

const TOO_VAGUE = phrase('(?:se)?(?:minggu|pekan|bulan) (?:yang )?lalu|beberapa hari (?:yang )?lalu');
const TOO_OLD = phrase('(?:se)?tahun (?:yang )?lalu|\\d+ tahun (?:yang )?lalu');
const FUTURE = phrase('besok|(?<!kemarin )lusa|(?:minggu|pekan|bulan|tahun) depan|\\d+ hari lagi');
const DAY_BEFORE_YESTERDAY = phrase('kemarin lusa');
const WEEKDAY_YESTERDAY = phrase(`(${Object.keys(WEEKDAYS).join('|')}) kemarin`);
const YESTERDAY = phrase('kemarin|kemaren');
const DAYS_AGO = phrase('(\\d+) hari (?:yang )?lalu');
const NIGHT = phrase('tadi malam|malam tadi');
const TODAY = phrase('tadi(?: pagi| siang| sore)?|barusan|hari ini');
// "tanggal 25", "tanggal 25 sep [2025]" atau "25 sep [2025]".
const EXPLICIT_DAY = phrase(`(?:tanggal|tgl\\.?) (\\d{1,2})(?: (${MONTH})(?: (\\d{4}))?)?`);
const DAY_MONTH = phrase(`(\\d{1,2}) (${MONTH})(?: (\\d{4}))?`);

export interface DateMatch {
  result: DateResult;
  /** Posisi penanda tanggal di teks; -1 bila tidak disebut atau ditolak tanpa potongan. */
  start: number;
  end: number;
}

function rejected(reason: DateRejectReason, matched: string, start: number): DateMatch {
  return { result: { status: 'rejected', reason, matched }, start, end: start + matched.length };
}

/** Memastikan tanggal tidak di masa depan dan tidak lebih dari satu tahun ke belakang. */
function bounded(date: CalendarDate, today: CalendarDate, matched: string, start: number): DateMatch {
  if (date > today) return rejected('future', matched, start);
  if (date < oneYearBefore(today)) return rejected('too_old', matched, start);
  return { result: { status: 'found', date, matched }, start, end: start + matched.length };
}

function dayOfWeek(date: CalendarDate): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Seperti `extractDate`, tetapi mengembalikan juga posisi penanda tanggalnya. */
export function findDate(text: string, now: Date): DateMatch {
  const today = toJakartaDate(now);
  const at = (pattern: RegExp): RegExpExecArray | null => pattern.exec(text);
  let m: RegExpExecArray | null;

  if ((m = at(TOO_VAGUE))) return rejected('too_vague', m[0], m.index);
  if ((m = at(TOO_OLD))) return rejected('too_old', m[0], m.index);
  if ((m = at(FUTURE))) return rejected('future', m[0], m.index);

  if ((m = at(DAY_BEFORE_YESTERDAY))) return bounded(addDays(today, -2), today, m[0], m.index);

  if ((m = at(WEEKDAY_YESTERDAY))) {
    // Hari itu yang terakhir sudah lewat; hari yang sama dengan hari ini berarti pekan lalu.
    const target = WEEKDAYS[m[1] as string] as number;
    const back = (dayOfWeek(today) - target + 7) % 7 || 7;
    return bounded(addDays(today, -back), today, m[0], m.index);
  }

  if ((m = at(YESTERDAY))) return bounded(addDays(today, -1), today, m[0], m.index);

  if ((m = at(DAYS_AGO))) {
    // Angka sebesar ini pasti lebih dari setahun; ditolak tanpa menghitung tanggalnya.
    const days = Number(m[1]);
    if (days > 3650) return rejected('too_old', m[0], m.index);
    return bounded(addDays(today, -days), today, m[0], m.index);
  }

  const absolute = at(EXPLICIT_DAY) ?? at(DAY_MONTH);
  if (absolute) {
    const matched = absolute[0];
    const [thisYear, thisMonth] = today.split('-').map(Number) as [number, number];
    const day = Number(absolute[1]);
    const month = absolute[2] ? (MONTHS[absolute[2]] as number) : thisMonth;
    const year = absolute[3] ? Number(absolute[3]) : thisYear;
    const date = `${year}-${pad(month)}-${pad(day)}`;
    if (!isValidDateString(date)) return rejected('invalid_date', matched, absolute.index);
    return bounded(date, today, matched, absolute.index);
  }

  if ((m = at(NIGHT))) {
    // Pesan pukul 00.00-03.59 yang menyebut "tadi malam" hampir pasti merujuk hari sebelumnya.
    const date = jakartaHour(now) < 4 ? addDays(today, -1) : today;
    return bounded(date, today, m[0], m.index);
  }

  if ((m = at(TODAY))) return bounded(today, today, m[0], m.index);

  return { result: { status: 'found', date: today, matched: '' }, start: -1, end: -1 };
}

export function extractDate(text: string, now: Date): DateResult {
  return findDate(text, now).result;
}
