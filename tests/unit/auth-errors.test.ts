import { AuthApiError, AuthRetryableFetchError, AuthUnknownError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { mapAuthError, type AuthOperation } from '../../src/lib/auth.js';
import { AppError } from '../../src/shared/errors/AppError.js';

function apiError(status: number, code: string, message = 'pesan mentah dari supabase'): AuthApiError {
  return new AuthApiError(message, status, code);
}

function map(error: unknown, operation: AuthOperation = 'login'): AppError {
  const result = mapAuthError(error, operation);
  expect(result).toBeInstanceOf(AppError);
  return result as AppError;
}

describe('mapAuthError', () => {
  it('email ganda saat register menjadi 409', () => {
    for (const code of ['user_already_exists', 'email_exists']) {
      const error = map(apiError(422, code), 'signUp');
      expect(error.code).toBe('CONFLICT');
      expect(error.status).toBe(409);
      expect(error.details?.[0]?.field).toBe('email');
    }
  });

  describe('penautan identitas (email sama lewat password dan Google)', () => {
    it.each([
      'identity_already_exists',
      'email_conflict_identity_not_deletable',
      'manual_linking_disabled',
      'provider_email_needs_verification',
    ])('%s menjadi 409 dengan pesan yang jelas, bukan 500', (code) => {
      const error = map(apiError(422, code), 'google');
      expect(error.status).toBe(409);
      expect(error.message).toMatch(/sudah terdaftar dengan metode masuk lain/);
      expect(error.details?.[0]?.issue).toBe('account_exists_other_provider');
    });
  });

  it('kredensial salah menjadi 401 tanpa membocorkan pesan mentah', () => {
    const error = map(apiError(400, 'invalid_credentials', 'Invalid login credentials'));
    expect(error.status).toBe(401);
    expect(error.message).not.toContain('Invalid login credentials');
    expect(error.message).toMatch(/Google/);
  });

  it('password lemah menjadi 400', () => {
    const error = map(apiError(422, 'weak_password'), 'signUp');
    expect(error.status).toBe(400);
    expect(error.details?.[0]?.field).toBe('password');
  });

  it('batas kirim Supabase menjadi 429', () => {
    expect(map(apiError(429, 'over_request_rate_limit')).status).toBe(429);
    expect(map(apiError(429, 'over_email_send_rate_limit'), 'forgot').status).toBe(429);
    // status 429 tanpa kode yang dikenal pun tetap 429
    expect(map(apiError(429, 'kode_baru_yang_belum_dikenal')).status).toBe(429);
  });

  it('provider Google belum aktif di dashboard menjadi 503 (konfigurasi, bukan salah pengguna)', () => {
    expect(map(apiError(400, 'provider_disabled'), 'google').status).toBe(503);
    expect(map(apiError(422, 'signup_disabled'), 'google').status).toBe(503);
  });

  it('token Google ditolak menjadi 401 untuk 400/401/422 tanpa kode yang dikenal', () => {
    for (const status of [400, 401, 422]) {
      const error = map(apiError(status, 'validation_failed', 'Unacceptable audience in id_token'), 'google');
      expect(error.status).toBe(401);
      expect(error.message).not.toContain('audience');
    }
  });

  it('refresh token tidak dikenal atau sudah dipakai menjadi 401', () => {
    expect(map(apiError(400, 'refresh_token_not_found'), 'refresh').status).toBe(401);
    expect(map(apiError(400, 'refresh_token_already_used'), 'refresh').status).toBe(401);
    expect(map(apiError(400, 'tidak_dikenal'), 'refresh').status).toBe(401);
  });

  it('token pemulihan tidak valid menjadi 401 pada reset-password', () => {
    expect(map(apiError(401, 'bad_jwt'), 'reset').status).toBe(401);
    expect(map(apiError(403, 'tidak_dikenal'), 'reset').status).toBe(401);
  });

  it('gangguan jaringan ke Supabase menjadi 503', () => {
    const error = map(new AuthRetryableFetchError('fetch failed', 0));
    expect(error.status).toBe(503);
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('error yang tidak dikenal dikembalikan null agar dilempar ulang (500 generik, tercatat)', () => {
    expect(mapAuthError(apiError(500, 'unexpected_failure'), 'login')).toBeNull();
    expect(mapAuthError(new AuthUnknownError('aneh', new Error('x')), 'login')).toBeNull();
    expect(mapAuthError(new Error('bug'), 'login')).toBeNull();
    expect(mapAuthError('string', 'login')).toBeNull();
  });
});
