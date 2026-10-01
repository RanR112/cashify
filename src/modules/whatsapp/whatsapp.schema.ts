import { z } from '../../shared/openapi/zod.js';
import { timestampSchema } from '../../shared/schemas/common.schema.js';
import { E164_ID_PATTERN } from '../../shared/utils/phone.js';

// E.164, berawalan +62 (pola dipakai bersama dengan normalizePhone).
const phoneSchema = z
  .string()
  .regex(E164_ID_PATTERN, 'Nomor harus format E.164 berawalan +62')
  .openapi({ example: '+628123456789', description: 'Format E.164 dan berawalan +62.' });

export const linkRequestBodySchema = z.object({ phone: phoneSchema }).openapi('LinkRequestBody');

export const linkVerifyBodySchema = z
  .object({
    code: z.string().regex(/^\d{6}$/, 'Kode harus 6 digit').openapi({ example: '483920' }),
  })
  .openapi('LinkVerifyBody');

export const preferencesBodySchema = z
  .object({
    daily_summary_enabled: z.boolean().optional(),
    budget_alert_enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Minimal satu field harus diisi' })
  .openapi('PreferencesBody', { description: 'Minimal satu field harus diisi.' });

const maskedPhoneSchema = z.string().openapi({ example: '+6281234xxxx9' });

export const preferencesSchema = z
  .object({
    daily_summary_enabled: z.boolean(),
    budget_alert_enabled: z.boolean(),
  })
  .openapi('WhatsappPreferences', {
    description: 'Keduanya mati secara default. Pengiriman otomatisnya sendiri di luar cakupan; ini hanya sakelar.',
  });

export const linkStatusSchema = z.enum(['unlinked', 'pending', 'verified']).openapi('WhatsappLinkStatus', {
  description:
    '`unlinked` mencakup belum pernah menautkan dan tautan yang diputus (di database: `disabled`).',
});

export const whatsappStatusSchema = z
  .object({
    status: linkStatusSchema,
    masked_phone: maskedPhoneSchema.nullable(),
    expires_at: timestampSchema.nullable().openapi({ description: 'Batas waktu OTP; hanya terisi saat `pending`.' }),
    verified_at: timestampSchema.nullable(),
    last_message_at: timestampSchema.nullable(),
    preferences: preferencesSchema,
  })
  .openapi('WhatsappStatus');

export const linkPendingSchema = z
  .object({
    status: z.literal('pending'),
    expires_at: timestampSchema.openapi({ description: 'OTP berlaku 10 menit.' }),
    masked_phone: maskedPhoneSchema,
  })
  .openapi('LinkPending');

export const linkVerifiedSchema = z
  .object({
    status: z.literal('verified'),
    phone: maskedPhoneSchema.openapi({ description: 'Nomor tersamarkan, sama seperti `masked_phone` di tempat lain.' }),
    verified_at: timestampSchema,
  })
  .openapi('LinkVerified');
