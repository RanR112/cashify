// Cursor paginasi: JSON dalam base64url. Bagi klien nilainya opak. Bentuk isinya
// (mis. { d: tanggal, i: id }) ditentukan modul pemakai lewat skema Zod, bukan di sini.

import type { z } from 'zod';
import { AppError } from '../errors/AppError.js';

const MAX_CURSOR_LENGTH = 500;

export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function invalidCursor(): AppError {
  return AppError.validation('Cursor tidak valid', [{ field: 'cursor', issue: 'invalid_cursor' }]);
}

/** Membaca dan memvalidasi cursor. Cursor rusak atau tidak cocok skema -> 400 VALIDATION_ERROR. */
export function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S> {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor();

  const bytes = Buffer.from(cursor, 'base64url');
  // Buffer.from menelan karakter sampah; tolak bentuk yang tidak kanonik.
  if (bytes.toString('base64url') !== cursor) throw invalidCursor();

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  const result = schema.safeParse(parsed);
  if (!result.success) throw invalidCursor();
  return result.data;
}
