import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createVerifyWebhook, secretsMatch } from '../../src/middleware/verifyWebhook.js';
import { isAppError } from '../../src/shared/errors/AppError.js';

const SECRET = 'a7f2k9m3q1b8x5c4v6n2d0e1f3g7h9j2';

async function run(path: unknown, getSecret: () => string | Promise<string> = () => SECRET) {
  const next = vi.fn();
  await createVerifyWebhook(getSecret)({ params: { path } } as unknown as Request, {} as Response, next as unknown as NextFunction);
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0]?.[0] as unknown;
}

describe('secretsMatch', () => {
  it('cocok hanya untuk string yang persis sama', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretsMatch(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(secretsMatch('', SECRET)).toBe(false);
    expect(secretsMatch(SECRET.toUpperCase(), SECRET)).toBe(false);
  });

  it('tidak melempar saat panjang berbeda jauh (timingSafeEqual mentah akan melempar)', () => {
    expect(() => secretsMatch('x', SECRET)).not.toThrow();
    expect(() => secretsMatch('x'.repeat(5000), SECRET)).not.toThrow();
  });
});

describe('createVerifyWebhook', () => {
  it('meneruskan permintaan bila segmen path sama dengan rahasia', async () => {
    expect(await run(SECRET)).toBeUndefined();
  });

  it('menerima rahasia dari getSecret async', async () => {
    expect(await run(SECRET, async () => SECRET)).toBeUndefined();
  });

  it('menolak 401 bila rahasia salah', async () => {
    const error = await run('rahasia-yang-salah-sama-sekali');
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('menolak 401 bila segmen path kosong atau bukan string', async () => {
    expect(await run('')).toMatchObject({ status: 401 });
    expect(await run(undefined)).toMatchObject({ status: 401 });
    expect(await run(['a', 'b'])).toMatchObject({ status: 401 });
  });
});
