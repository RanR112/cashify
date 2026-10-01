import { describe, expect, it } from 'vitest';
import {
  E164_ID_PATTERN,
  fromWaChatId,
  maskPhone,
  maskPhoneForLog,
  normalizePhone,
  toWaChatId,
} from '../../src/shared/utils/phone.js';

describe('normalizePhone', () => {
  it.each([
    ['08123456789', '+628123456789'],
    ['0812-3456-789', '+628123456789'],
    ['(0812) 3456 789', '+628123456789'],
    ['628123456789', '+628123456789'],
    ['+628123456789', '+628123456789'],
    ['+62 812 3456 789', '+628123456789'],
    ['+62-812-3456-789', '+628123456789'],
    ['  08123456789  ', '+628123456789'],
    ['0211234567', '+62211234567'],
  ])('%j -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ['angka telanjang tanpa 0 atau 62 (ambigu)', '8123456789'],
    ['kode negara lain', '+14155550123'],
    ['kode negara lain tanpa plus', '14155550123'],
    ['terlalu pendek', '0812'],
    ['terlalu panjang', '+6281234567890123'],
    ['nol setelah 62', '620812345678'],
    ['plus lalu nol', '+0812345678'],
    ['awalan 00', '00628123456789'],
    ['kosong', ''],
    ['huruf', 'abc'],
    ['campuran huruf', '0812abc6789'],
  ])('null untuk %s: %j', (_label, input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it('hasilnya selalu lolos E164_ID_PATTERN', () => {
    expect(E164_ID_PATTERN.test(normalizePhone('08123456789') as string)).toBe(true);
  });
});

describe('toWaChatId / fromWaChatId', () => {
  it('E.164 -> wa_chat_id format 628xxx@c.us', () => {
    expect(toWaChatId('+628123456789')).toBe('628123456789@c.us');
  });

  it('melempar bila bukan nomor Indonesia E.164 (agar pesan tak terkirim ke chat salah)', () => {
    expect(() => toWaChatId('08123456789')).toThrow(RangeError);
    expect(() => toWaChatId('+14155550123')).toThrow(RangeError);
    expect(() => toWaChatId('')).toThrow(RangeError);
  });

  it('wa_chat_id -> E.164', () => {
    expect(fromWaChatId('628123456789@c.us')).toBe('+628123456789');
  });

  it('round-trip', () => {
    expect(fromWaChatId(toWaChatId('+628123456789'))).toBe('+628123456789');
  });

  it.each([
    ['grup', '120363025246125486@g.us'],
    ['bukan chat id', '628123456789'],
    ['domain lain', '628123456789@lid'],
    ['kosong', ''],
    ['ada huruf', 'abc@c.us'],
  ])('null untuk %s', (_label, chatId) => {
    expect(fromWaChatId(chatId)).toBeNull();
  });
});

describe('penyamaran', () => {
  it('maskPhone mengikuti contoh UI di ARCHITECTURE Bagian 15', () => {
    expect(maskPhone('+628123456789')).toBe('+6281234xxxx9');
  });

  it('maskPhone menyesuaikan panjang nomor', () => {
    expect(maskPhone('+6281234567890')).toBe('+6281234xxxxx0');
  });

  it('maskPhone tidak melempar pada nomor sangat pendek', () => {
    expect(maskPhone('+6281')).toMatch(/^\+62x*1$/);
  });

  it('maskPhoneForLog mengikuti contoh log di ARCHITECTURE Bagian 15', () => {
    expect(maskPhoneForLog('+628123456789')).toBe('628xxxxxx789');
  });

  it('maskPhoneForLog menerima wa_chat_id', () => {
    expect(maskPhoneForLog('628123456789@c.us')).toBe('628xxxxxx789');
  });

  it('maskPhoneForLog menyembunyikan seluruh nomor yang terlalu pendek', () => {
    expect(maskPhoneForLog('12345')).toBe('xxxxx');
  });

  it('hasil penyamaran tidak pernah memuat digit tengah', () => {
    expect(maskPhone('+628123456789')).not.toContain('5678');
    expect(maskPhoneForLog('+628123456789')).not.toContain('123456');
  });
});
