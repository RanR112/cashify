import type { RequestHandler } from 'express';
import { AppError, isAppError } from '../shared/errors/AppError.js';
import { createTokenVerifier, type TokenVerifier } from '../shared/utils/token.js';

const MAX_TOKEN_LENGTH = 8192;
const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Memverifikasi `Authorization: Bearer <jwt>` lalu mengisi `req.user` dari klaim `sub`.
 * `user_id` TIDAK PERNAH dibaca dari body, query, atau params (aturan 8).
 */
export function createAuthenticate(verify: TokenVerifier): RequestHandler {
  return async (req, _res, next) => {
    const match = BEARER.exec(req.headers.authorization ?? '');
    const token = match?.[1];
    if (!token || token.length > MAX_TOKEN_LENGTH) {
      next(AppError.unauthorized('Token autentikasi tidak ada'));
      return;
    }

    try {
      req.user = await verify(token);
      next();
    } catch (error) {
      next(isAppError(error) ? error : AppError.unauthorized('Token tidak valid atau kedaluwarsa'));
    }
  };
}

// env.ts memanggil process.exit bila variabel hilang, jadi tidak boleh diimpor di level
// modul: berkas ini harus bisa dimuat di test tanpa .env. Verifier bawaan dibuat saat
// request pertama; JWKS Supabase di-cache oleh jose sesudahnya.
let defaultVerifier: TokenVerifier | undefined;

const lazyVerifier: TokenVerifier = async (token) => {
  if (!defaultVerifier) {
    const { env } = await import('../config/env.js');
    defaultVerifier = createTokenVerifier({
      supabaseUrl: env.SUPABASE_URL,
      jwtSecret: env.SUPABASE_JWT_SECRET,
    });
  }
  return defaultVerifier(token);
};

export const authenticate: RequestHandler = createAuthenticate(lazyVerifier);
