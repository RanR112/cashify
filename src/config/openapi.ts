// Perakit dokumen OpenAPI. Sengaja TIDAK mengimpor ./env.js: skrip ekspor dan test
// harus jalan tanpa .env.

import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from '../shared/openapi/zod.js';
import { jsonResponse, registerRoute, registry } from '../shared/openapi/registry.js';

// Efek samping impor: tiap berkas mendaftarkan endpoint-nya ke registry.
import '../modules/auth/auth.openapi.js';
import '../modules/users/users.openapi.js';
import '../modules/dashboard/dashboard.openapi.js';
import '../modules/transactions/transactions.openapi.js';
import '../modules/categories/categories.openapi.js';
import '../modules/accounts/accounts.openapi.js';
import '../modules/whatsapp/whatsapp.openapi.js';
import '../modules/webhooks/webhooks.openapi.js';

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'JWT dari Supabase Auth (`session.access_token` hasil login/register).',
});

// /health tidak punya modul; bentuk responsnya sama dengan yang sudah ada di app.ts.
registerRoute({
  method: 'get',
  path: '/health',
  tag: 'Sistem',
  summary: 'Status layanan',
  auth: 'none',
  responses: {
    200: jsonResponse('Layanan hidup.', z.object({ status: z.literal('ok') }).openapi('HealthResponse')),
  },
});

export const API_TAGS = [
  { name: 'Auth', description: 'Pendaftaran, login, dan pemulihan password. Identitas dipegang Supabase Auth.' },
  { name: 'Profil', description: 'Profil pengguna yang sedang login.' },
  { name: 'Dashboard', description: 'Ringkasan beranda dalam satu panggilan.' },
  { name: 'Transaksi', description: 'CRUD transaksi dengan soft delete dan optimistic locking.' },
  { name: 'Kategori', description: 'Kategori sistem dan kustom.' },
  { name: 'Akun', description: 'Dompet pengguna.' },
  { name: 'WhatsApp', description: 'Penautan nomor lewat OTP dan preferensi.' },
  { name: 'Webhook', description: 'Penerima event OpenWA. Bukan untuk klien mobile.' },
  { name: 'Sistem', description: 'Pemeriksaan kesehatan.' },
];

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Cashify API',
      version: '0.1.0',
      description:
        'API keuangan pribadi Cashify. Nominal selalu bilangan bulat rupiah; tanggal `YYYY-MM-DD`, timestamp ISO 8601 UTC. ' +
        'Semua error memakai satu bentuk (`ErrorResponse`). Dokumen ini dihasilkan dari skema Zod di `src/modules/*/*.schema.ts`.',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Lokal' }],
    tags: API_TAGS,
  });
}
