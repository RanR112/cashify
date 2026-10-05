import { describe, expect, it } from 'vitest';
import {
  buildOtpMessage,
  generateCode,
  hashCode,
  OTP_LENGTH,
  OTP_TTL_MS,
  verifyCode,
} from '../../src/modules/whatsapp/whatsapp.otp.js';

describe('generateCode', () => {
  it('selalu 6 digit angka, termasuk yang berawalan nol', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
  });

  it('tidak konstan', () => {
    const codes = new Set(Array.from({ length: 50 }, generateCode));
    expect(codes.size).toBeGreaterThan(40);
    expect(OTP_LENGTH).toBe(6);
  });
});

describe('hashCode / verifyCode', () => {
  it('hash bukan kode polos dan berformat bcrypt', async () => {
    const hash = await hashCode('483920', 4);
    expect(hash).not.toContain('483920');
    expect(hash).toMatch(/^\$2[aby]\$/);
  });

  it('kode yang sama cocok; kode lain tidak', async () => {
    const hash = await hashCode('004821', 4);
    expect(await verifyCode('004821', hash)).toBe(true);
    expect(await verifyCode('004822', hash)).toBe(false);
    expect(await verifyCode('4821', hash)).toBe(false);
  });

  it('dua hash dari kode yang sama berbeda (salt acak)', async () => {
    expect(await hashCode('111111', 4)).not.toBe(await hashCode('111111', 4));
  });
});

describe('buildOtpMessage', () => {
  it('memuat kode dan masa berlaku, dalam Bahasa Indonesia', () => {
    const message = buildOtpMessage('483920');
    expect(message).toContain('483920');
    expect(message).toContain(`${OTP_TTL_MS / 60_000} menit`);
    expect(message).toMatch(/jangan bagikan/i);
  });
});
