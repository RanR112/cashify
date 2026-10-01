// Pesan validasi Zod dalam bahasa Indonesia (locale bawaan Zod 4), dipasang sekali saat
// modul ini dimuat. Pesan khusus yang ditulis di skema tetap menang atas locale.

import { z } from 'zod';
import type { ErrorDetail } from '../errors/AppError.js';

z.config(z.locales.id());

/** Ubah isu Zod menjadi `details` sesuai bentuk error ARCHITECTURE.md Bagian 12. */
export function zodIssuesToDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => {
    const field = issue.path.map(String).join('.');
    return field ? { field, issue: issue.code } : { issue: issue.code };
  });
}

/** Pesan ringkas untuk `error.message`: pesan isu pertama, yang sudah berbahasa Indonesia. */
export function zodErrorMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Input tidak valid';
}
