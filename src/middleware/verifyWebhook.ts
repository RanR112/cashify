import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors/AppError.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Perbandingan waktu-tetap. Kedua sisi di-hash lebih dulu: `timingSafeEqual` melempar bila panjang
 * buffer berbeda, dan memeriksa panjang sendiri akan membocorkan panjang rahasia.
 */
export function secretsMatch(candidate: string, expected: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

/**
 * Verifikasi webhook OpenWA. OpenWA v4 tidak bisa mengirim header kustom lewat flag `-w`, jadi
 * rahasia ada di segmen path (`/webhooks/openwa/:path`), bukan di header. Dipisah dari
 * `authenticate.ts` karena mekanismenya sama sekali berbeda.
 *
 * `getSecret` dipanggil per permintaan supaya env baru dibaca saat dipakai, bukan saat berkas dimuat.
 */
export function createVerifyWebhook(getSecret: () => string | Promise<string>): RequestHandler {
  return async (req, _res, next) => {
    const candidate = req.params['path'];
    const expected = await getSecret();
    if (typeof candidate !== 'string' || candidate.length === 0 || !secretsMatch(candidate, expected)) {
      next(AppError.unauthorized('Rahasia webhook tidak valid'));
      return;
    }
    next();
  };
}
