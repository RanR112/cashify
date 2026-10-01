import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/shared/errors/AppError.js';
import { decodeCursor, encodeCursor } from '../../src/shared/utils/cursor.js';

const schema = z.object({ d: z.iso.date(), i: z.uuid() });
const payload = { d: '2026-09-28', i: '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21' };

function catchError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('Diharapkan melempar');
}

describe('encodeCursor / decodeCursor', () => {
  it('round-trip', () => {
    expect(decodeCursor(encodeCursor(payload), schema)).toEqual(payload);
  });

  it('aman untuk URL: base64url tanpa +, /, =', () => {
    const cursor = encodeCursor({ ...payload, pad: '???>>>~~~' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hasil decode lewat skema (field tak dikenal dibuang)', () => {
    const cursor = encodeCursor({ ...payload, tambahan: 'x' });
    expect(decodeCursor(cursor, schema)).toEqual(payload);
  });

  it.each([
    ['kosong', ''],
    ['karakter sampah', 'bukan base64 !!!'],
    ['bukan JSON', Buffer.from('ini bukan json').toString('base64url')],
    ['JSON dengan bentuk salah', encodeCursor({ d: 'kemarin', i: 123 })],
    ['JSON primitif', encodeCursor('teks')],
    ['null', encodeCursor(null)],
    ['tidak kanonik (padding)', `${encodeCursor(payload)}==`],
    ['terlalu panjang', 'A'.repeat(501)],
  ])('menolak cursor %s', (_label, cursor) => {
    const error = catchError(() => decodeCursor(cursor, schema));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.status).toBe(400);
    expect(error.details).toEqual([{ field: 'cursor', issue: 'invalid_cursor' }]);
  });

  it('pesan error tidak membocorkan isi cursor', () => {
    const error = catchError(() => decodeCursor(encodeCursor({ rahasia: 'xyz-789' }), schema));
    expect(error.message).not.toContain('xyz-789');
  });
});
