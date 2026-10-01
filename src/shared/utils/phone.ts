// Nomor telepon: normalisasi ke E.164, konversi ke wa_chat_id OpenWA, dan penyamaran.
// Nomor disimpan penuh tetapi disamarkan di mana pun ditampilkan atau dicatat
// (ARCHITECTURE.md Bagian 15).

/** Nomor Indonesia E.164: +62, lalu 8-12 digit yang tidak diawali 0. */
export const E164_ID_PATTERN = /^\+62[1-9]\d{7,11}$/;

const WA_USER_CHAT_ID = /^(\d{8,15})@c\.us$/;

/**
 * "0812-3456-789", "62812...", "+62 812 ..." -> "+62812...". Selain itu null.
 * Hanya nomor Indonesia yang diterima; angka telanjang tanpa 0/62 sengaja ditolak karena ambigu.
 */
export function normalizePhone(input: string): string | null {
  const cleaned = input.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return null;

  const hasPlus = cleaned.startsWith('+');
  let digits = hasPlus ? cleaned.slice(1) : cleaned;

  if (!hasPlus && digits.startsWith('0')) {
    digits = `62${digits.slice(1)}`;
  } else if (!digits.startsWith('62')) {
    return null;
  }

  const e164 = `+${digits}`;
  return E164_ID_PATTERN.test(e164) ? e164 : null;
}

/** "+628123456789" -> "628123456789@c.us". Melempar bila bukan nomor Indonesia yang sah. */
export function toWaChatId(e164: string): string {
  if (!E164_ID_PATTERN.test(e164)) {
    throw new RangeError('Nomor harus E.164 Indonesia (+62...)');
  }
  return `${e164.slice(1)}@c.us`;
}

/** "628123456789@c.us" -> "+628123456789". Grup (@g.us) dan format lain -> null. */
export function fromWaChatId(chatId: string): string | null {
  const match = WA_USER_CHAT_ID.exec(chatId);
  return match ? `+${match[1]}` : null;
}

/** Untuk tampilan: "+628123456789" -> "+6281234xxxx9" (7 digit awal dan 1 digit akhir tampak). */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 9) {
    return `+${digits.slice(0, 2)}${'x'.repeat(Math.max(digits.length - 3, 0))}${digits.slice(-1)}`;
  }
  return `+${digits.slice(0, 7)}${'x'.repeat(digits.length - 8)}${digits.slice(-1)}`;
}

/** Untuk log: "+628123456789" atau "628123456789@c.us" -> "628xxxxxx789" (3 digit awal dan akhir). */
export function maskPhoneForLog(value: string): string {
  const digits = value.replace(/@.*$/, '').replace(/\D/g, '');
  if (digits.length < 7) return 'x'.repeat(digits.length);
  return `${digits.slice(0, 3)}${'x'.repeat(digits.length - 6)}${digits.slice(-3)}`;
}
