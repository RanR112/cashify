// OTP penautan: membuat, meng-hash, memeriksa, dan merangkai pesannya. Tanpa Prisma dan tanpa
// modul lain, jadi mudah diuji.
//
// Kode di-hash dengan bcrypt seperti password: orang yang membaca database tidak boleh bisa
// menautkan nomor orang lain (ARCHITECTURE.md Bagian 9). Kode polos hanya ada sebentar di memori
// dan di pesan WhatsApp ke pemilik nomor.

import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
/** Jeda minimal antar pengiriman OTP (resend). */
export const OTP_RESEND_GAP_MS = 60 * 1000;
export const OTP_PER_PHONE_PER_DAY = 3;
export const OTP_PER_USER_PER_DAY = 5;
export const OTP_WINDOW_MS = 24 * 60 * 60 * 1000;

const BCRYPT_COST = 10;

export interface OtpToolkit {
  generateCode(): string;
  hashCode(code: string): Promise<string>;
  verifyCode(code: string, hash: string): Promise<boolean>;
}

/** 6 digit, boleh berawalan nol ("004821"). Memakai CSPRNG, bukan Math.random. */
export function generateCode(): string {
  return randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');
}

export function hashCode(code: string, cost: number = BCRYPT_COST): Promise<string> {
  return bcrypt.hash(code, cost);
}

export function verifyCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}

export const defaultOtp: OtpToolkit = { generateCode, hashCode: (code) => hashCode(code), verifyCode };

/** Balasan ke pengguna dirakit dari template di kode (aturan 3). */
export function buildOtpMessage(code: string): string {
  const minutes = OTP_TTL_MS / 60_000;
  return (
    `Kode verifikasi Cashify Anda: ${code}\n` +
    `Berlaku ${minutes} menit. Jangan bagikan kode ini kepada siapa pun, termasuk yang mengaku dari Cashify.`
  );
}
