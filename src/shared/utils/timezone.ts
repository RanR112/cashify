// SEMUA perhitungan zona waktu Asia/Jakarta ada di berkas ini. Jangan menghitung offset,
// jam, atau batas bulan di tempat lain: bug zona waktu muncul beberapa bulan sekali,
// biasanya di pergantian bulan (BACKEND-STRUCTURE.md Bagian 6).
//
// Indonesia Barat (WIB) adalah UTC+7 tanpa daylight saving, jadi offset tetap sah dan
// aritmetikanya eksak. Tanggal kalender ditulis YYYY-MM-DD, bulan YYYY-MM.

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Tanggal kalender di Jakarta untuk sebuah instan waktu. */
export function toJakartaDate(date: Date): string {
  return new Date(date.getTime() + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Jam di Jakarta (0-23). Dipakai aturan "tadi malam" pukul 00.00-04.00. */
export function jakartaHour(date: Date): number {
  return new Date(date.getTime() + JAKARTA_OFFSET_MS).getUTCHours();
}

/** Tanggal hari ini di Jakarta. `now` bisa disuntik untuk test. */
export function todayInJakarta(now: Date = new Date()): string {
  return toJakartaDate(now);
}

/** Bulan berjalan di Jakarta, format YYYY-MM. */
export function currentMonthInJakarta(now: Date = new Date()): string {
  return toJakartaDate(now).slice(0, 7);
}

/** True bila string adalah tanggal kalender yang benar-benar ada ("2026-02-30" -> false). */
export function isValidDateString(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function assertDate(value: string): [number, number, number] {
  if (!isValidDateString(value)) {
    throw new RangeError(`Bukan tanggal YYYY-MM-DD yang sah: ${value}`);
  }
  const match = DATE_PATTERN.exec(value) as RegExpExecArray;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Geser tanggal kalender sebanyak `days` hari (boleh negatif). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = assertDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Tanggal satu tahun sebelum `today`. 29 Februari menjadi 28 Februari. */
export function oneYearBefore(today: string): string {
  const [year, month, day] = assertDate(today);
  const d = new Date(Date.UTC(year - 1, month - 1, day));
  if (d.getUTCMonth() !== month - 1) {
    d.setUTCDate(0);
  }
  return d.toISOString().slice(0, 10);
}

/** Tanggal pertama dan terakhir sebuah bulan: "2026-09" -> { from: "2026-09-01", to: "2026-09-30" }. */
export function monthBounds(month: string): { from: string; to: string } {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new RangeError(`Bukan bulan YYYY-MM yang sah: ${month}`);
  const [year, mon] = [Number(match[1]), Number(match[2])];
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/** Instan UTC saat hari `date` dimulai di Jakarta (00:00 WIB = 17:00 UTC hari sebelumnya). */
export function jakartaDayStartUtc(date: string): Date {
  assertDate(date);
  return new Date(`${date}T00:00:00+07:00`);
}
