import { jsonBody, jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import { messageResponseSchema } from '../../shared/schemas/common.schema.js';
import { authResultSchema, sessionSchema } from '../../shared/schemas/user.schema.js';
import { z } from '../../shared/openapi/zod.js';
import {
  forgotPasswordBodySchema,
  googleBodySchema,
  loginBodySchema,
  refreshBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
} from './auth.schema.js';

const TAG = 'Auth';

registerRoute({
  method: 'post',
  path: '/auth/register',
  tag: TAG,
  summary: 'Daftar akun baru',
  description:
    'Membuat akun Supabase Auth, baris `users`, akun default "Tunai", dan salinan kategori sistem dalam satu transaksi database. ' +
    'Bila salah satu gagal, semuanya dibatalkan. Mengasumsikan konfirmasi email Supabase dimatikan sehingga sesi langsung diterbitkan. ' +
    'Rate limit: 3 per jam per IP.',
  auth: 'none',
  request: { body: jsonBody(registerBodySchema) },
  responses: { 201: jsonResponse('Akun dibuat.', authResultSchema) },
  errors: ['CONFLICT', 'RATE_LIMITED'],
});

registerRoute({
  method: 'post',
  path: '/auth/login',
  tag: TAG,
  summary: 'Masuk',
  description: 'Proksi ke Supabase Auth. Rate limit: 5 per 15 menit per IP.',
  auth: 'none',
  request: { body: jsonBody(loginBodySchema) },
  responses: { 200: jsonResponse('Login berhasil.', authResultSchema) },
  errors: ['UNAUTHORIZED', 'RATE_LIMITED'],
});

registerRoute({
  method: 'post',
  path: '/auth/google',
  tag: TAG,
  summary: 'Masuk atau daftar dengan Google',
  description:
    'Klien melakukan Google Sign-In native, lalu mengirim `id_token` ke sini. Backend meneruskannya ke Supabase Auth ' +
    '(`signInWithIdToken`), yang memverifikasinya ke Google dan menerbitkan sesi. ' +
    'Login pertama membuat baris `users`, akun "Tunai", dan salinan kategori sistem dalam satu transaksi; login berikutnya tidak membuat apa pun. ' +
    'Bila email yang sama sudah terdaftar lewat password, hasilnya mengikuti pengaturan penautan identitas di Supabase: ' +
    'ditautkan, atau ditolak dengan 409. Rate limit sama dengan login: 5 per 15 menit per IP (dihitung bersama).',
  auth: 'none',
  request: { body: jsonBody(googleBodySchema) },
  responses: { 200: jsonResponse('Login berhasil.', authResultSchema) },
  errors: ['UNAUTHORIZED', 'CONFLICT', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE'],
});

registerRoute({
  method: 'post',
  path: '/auth/refresh',
  tag: TAG,
  summary: 'Tukar refresh token',
  description: 'Refresh token dirotasi: token lama tidak berlaku setelah dipakai.',
  auth: 'none',
  request: { body: jsonBody(refreshBodySchema) },
  responses: { 200: jsonResponse('Sesi baru.', z.object({ session: sessionSchema }).openapi('RefreshResult')) },
  errors: ['UNAUTHORIZED'],
});

registerRoute({
  method: 'post',
  path: '/auth/logout',
  tag: TAG,
  summary: 'Keluar',
  description: 'Mencabut refresh token sesi saat ini.',
  auth: 'jwt',
  responses: { 204: { description: 'Berhasil keluar.' } },
});

registerRoute({
  method: 'post',
  path: '/auth/forgot-password',
  tag: TAG,
  summary: 'Kirim email reset password',
  description:
    'Selalu mengembalikan 200 dengan pesan yang sama, terdaftar atau tidak, agar daftar email tidak bisa ditebak. ' +
    'SMTP bawaan Supabase free tier punya batas kirim rendah.',
  auth: 'none',
  request: { body: jsonBody(forgotPasswordBodySchema) },
  responses: { 200: jsonResponse('Permintaan diterima.', messageResponseSchema) },
  errors: ['RATE_LIMITED'],
});

registerRoute({
  method: 'post',
  path: '/auth/reset-password',
  tag: TAG,
  summary: 'Setel password baru',
  description: 'Memakai token pemulihan dari tautan email. Token tidak valid atau kedaluwarsa menghasilkan 401.',
  auth: 'none',
  request: { body: jsonBody(resetPasswordBodySchema) },
  responses: { 204: { description: 'Password diganti.' } },
  errors: ['UNAUTHORIZED'],
});
