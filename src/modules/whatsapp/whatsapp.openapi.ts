import { jsonBody, jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import {
  linkPendingSchema,
  linkRequestBodySchema,
  linkVerifiedSchema,
  linkVerifyBodySchema,
  preferencesBodySchema,
  whatsappStatusSchema,
} from './whatsapp.schema.js';

const TAG = 'WhatsApp';

registerRoute({
  method: 'get',
  path: '/whatsapp/status',
  tag: TAG,
  summary: 'Status tautan WhatsApp',
  description: 'Tiga keadaan: `unlinked`, `pending` (menunggu OTP), `verified`.',
  auth: 'jwt',
  responses: { 200: jsonResponse('Status tautan.', whatsappStatusSchema) },
});

registerRoute({
  method: 'post',
  path: '/whatsapp/link/request',
  tag: TAG,
  summary: 'Kirim OTP ke nomor',
  description:
    'OTP 6 digit dikirim bot ke nomor itu, berlaku 10 menit. Batas: 3 permintaan per nomor per hari, 5 per pengguna per hari. ' +
    '409 bila nomor sudah dipakai akun terverifikasi lain; 503 bila sesi bot sedang terputus.',
  auth: 'jwt',
  request: { body: jsonBody(linkRequestBodySchema) },
  responses: { 200: jsonResponse('OTP dikirim.', linkPendingSchema) },
  errors: ['CONFLICT', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE'],
});

registerRoute({
  method: 'post',
  path: '/whatsapp/link/verify',
  tag: TAG,
  summary: 'Verifikasi kode OTP',
  description:
    'Kode salah mengembalikan 400 dengan `details[].attempts_left`. Setelah 5 percobaan salah, ' +
    'permintaan diblokir dan pengguna harus meminta kode baru. 404 bila tidak ada verifikasi yang menunggu.',
  auth: 'jwt',
  request: { body: jsonBody(linkVerifyBodySchema) },
  responses: { 200: jsonResponse('Nomor terverifikasi.', linkVerifiedSchema) },
  errors: ['NOT_FOUND', 'RATE_LIMITED'],
});

registerRoute({
  method: 'post',
  path: '/whatsapp/link/resend',
  tag: TAG,
  summary: 'Kirim ulang OTP',
  description:
    'Memakai nomor dari permintaan yang sedang menunggu; tanpa body. Dibatasi bersama batas harian `link/request` ' +
    'dan jeda minimal 60 detik. 404 bila tidak ada permintaan yang menunggu.',
  auth: 'jwt',
  responses: { 200: jsonResponse('OTP baru dikirim.', linkPendingSchema) },
  errors: ['NOT_FOUND', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE'],
});

registerRoute({
  method: 'delete',
  path: '/whatsapp/link',
  tag: TAG,
  summary: 'Putuskan tautan',
  description:
    'Soft: `status` menjadi `disabled`, baris tidak dihapus, riwayat pesan tetap bisa ditelusuri. ' +
    'Pengguna dapat menautkan ulang kapan saja lewat OTP.',
  auth: 'jwt',
  responses: { 204: { description: 'Tautan diputus.' } },
  errors: ['NOT_FOUND'],
});

registerRoute({
  method: 'patch',
  path: '/whatsapp/preferences',
  tag: TAG,
  summary: 'Ubah sakelar ringkasan dan peringatan',
  description: 'Hanya berlaku untuk tautan `verified`; selain itu 404.',
  auth: 'jwt',
  request: { body: jsonBody(preferencesBodySchema) },
  responses: { 200: jsonResponse('Status setelah diubah.', whatsappStatusSchema) },
  errors: ['NOT_FOUND'],
});
