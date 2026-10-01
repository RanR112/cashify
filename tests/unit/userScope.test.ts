import { describe, expect, it } from 'vitest';
import { ownedBy, requireUserId, visibleTo } from '../../src/shared/utils/userScope.js';

const USER = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';

describe('requireUserId', () => {
  it('mengembalikan UUID yang sah apa adanya', () => {
    expect(requireUserId(USER)).toBe(USER);
  });

  // `undefined` adalah kasus yang berbahaya: Prisma membuang `{ userId: undefined }` dari where.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['string kosong', ''],
    ['bukan UUID', 'abc'],
    ['UUID dengan sisipan SQL', `${USER}' OR '1'='1`],
    ['angka', 42],
    ['objek filter Prisma', { not: USER }],
  ])('melempar untuk %s', (_name, value) => {
    expect(() => requireUserId(value)).toThrow(TypeError);
  });
});

describe('ownedBy', () => {
  it('menyaring menurut pemilik dan baris yang belum dihapus', () => {
    expect(ownedBy(USER)).toEqual({ userId: USER, deletedAt: null });
  });

  it('melempar bila userId hilang, alih-alih menghasilkan filter kosong', () => {
    expect(() => ownedBy(undefined as unknown as string)).toThrow(TypeError);
  });
});

describe('visibleTo', () => {
  it('berbentuk user_id IS NULL OR user_id = $1, belum dihapus', () => {
    expect(visibleTo(USER)).toEqual({ OR: [{ userId: null }, { userId: USER }], deletedAt: null });
  });

  it('melempar bila userId hilang', () => {
    expect(() => visibleTo('')).toThrow(TypeError);
  });
});
