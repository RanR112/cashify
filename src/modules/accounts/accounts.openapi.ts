import { jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import { listAccountsResponseSchema } from './accounts.schema.js';

registerRoute({
  method: 'get',
  path: '/accounts',
  tag: 'Akun',
  summary: 'Daftar dompet',
  description: 'Setiap pengguna punya akun default "Tunai" sejak registrasi. Dompet tambahan belum bisa dibuat di cakupan ini.',
  auth: 'jwt',
  responses: { 200: jsonResponse('Daftar dompet milik pengguna.', listAccountsResponseSchema) },
});
