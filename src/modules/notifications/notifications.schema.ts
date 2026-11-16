import { z } from '../../shared/openapi/zod.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  timestampSchema,
  uuidSchema,
} from '../../shared/schemas/common.schema.js';

// ---- request ----

/**
 * Nilai kolom `type`. Hanya dua jenis ini yang dibuat sistem (PHASE2-DECISIONS Q9);
 * kolomnya VARCHAR, jadi daftar tertutup ini dijaga Zod.
 */
export const notificationTypeSchema = z.enum(['budget_alert', 'daily_summary']).openapi('NotificationType');

/** Sistem hanya membuat `whatsapp`; dua nilai lain diterima kolom tetapi tidak pernah dibuat. */
export const notificationChannelSchema = z.enum(['whatsapp', 'push', 'in_app']).openapi('NotificationChannel');

/** `read` berarti sudah dilihat di aplikasi, bukan bukti dibaca di WhatsApp. */
export const notificationStatusSchema = z
  .enum(['pending', 'sent', 'failed', 'read'])
  .openapi('NotificationStatus');

export const listNotificationsQuerySchema = paginationQuerySchema.extend({
  status: notificationStatusSchema.optional().openapi({
    description: 'Menyaring riwayat menurut status pengiriman.',
  }),
});

/** Isi cursor: `created_at` dan `id` baris terakhir halaman sebelumnya. Opak bagi klien. */
export const notificationCursorSchema = z.object({
  t: timestampSchema,
  i: uuidSchema,
});

// ---- response ----

/** `payload` sengaja tidak ada: hanya menyimpan id internal dan tanggal. */
export const notificationSchema = z
  .object({
    id: uuidSchema,
    type: notificationTypeSchema,
    channel: notificationChannelSchema,
    title: z.string().openapi({ example: 'Peringatan anggaran' }),
    body: z.string().openapi({ example: 'Anggaran Makanan terpakai 85% dari Rp1.000.000.' }),
    status: notificationStatusSchema,
    scheduled_for: timestampSchema.nullable(),
    sent_at: timestampSchema.nullable(),
    created_at: timestampSchema,
  })
  .openapi('Notification');

export const notificationListSchema = paginatedSchema(notificationSchema, 'NotificationList');
