// Verifikasi JWT Supabase. Express memverifikasi token, tidak pernah menerbitkannya.
// Murni: semua konfigurasi lewat parameter (tidak mengimpor env) supaya bisa diuji.

import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../errors/AppError.js';
import type { AuthUser } from '../types/express.js';

export interface TokenVerifierOptions {
  supabaseUrl: string;
  /** SUPABASE_JWT_SECRET; dipakai untuk token HS256 (proyek Supabase dengan secret lama). */
  jwtSecret: string;
  /** Penyedia kunci publik. Bawaan: JWKS Supabase (ber-cache). Disuntik di test. */
  jwks?: JWTVerifyGetKey;
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

const ASYMMETRIC_ALGORITHMS = ['ES256', 'RS256', 'EdDSA'];

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const issuer = `${options.supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
  const secret = new TextEncoder().encode(options.jwtSecret);
  const jwks = options.jwks ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const claims = { issuer, audience: 'authenticated' };

  return async (token) => {
    try {
      const { alg } = decodeProtectedHeader(token);
      const { payload } =
        alg === 'HS256'
          ? await jwtVerify(token, secret, { ...claims, algorithms: ['HS256'] })
          : await jwtVerify(token, jwks, { ...claims, algorithms: ASYMMETRIC_ALGORITHMS });

      // user_id selalu dari klaim `sub` (aturan 8).
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new Error('klaim sub hilang');
      }
      return {
        id: payload.sub,
        ...(typeof payload.email === 'string' && { email: payload.email }),
      };
    } catch {
      // Alasan sebenarnya (kedaluwarsa, tanda tangan, aud, iss) sengaja tidak dibocorkan.
      throw AppError.unauthorized('Token tidak valid atau kedaluwarsa');
    }
  };
}
