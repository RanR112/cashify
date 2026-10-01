import { jsonBody, jsonResponse, registerRoute } from '../../shared/openapi/registry.js';
import { userProfileSchema } from '../../shared/schemas/user.schema.js';
import { updateMeBodySchema } from './users.schema.js';

const TAG = 'Profil';

registerRoute({
  method: 'get',
  path: '/me',
  tag: TAG,
  summary: 'Profil pengguna',
  description: 'Identitas diambil dari klaim JWT, tidak pernah dari parameter.',
  auth: 'jwt',
  responses: { 200: jsonResponse('Profil.', userProfileSchema) },
  errors: ['NOT_FOUND'],
});

registerRoute({
  method: 'patch',
  path: '/me',
  tag: TAG,
  summary: 'Ubah profil',
  description: 'Mengubah sebagian field: nama, avatar, saldo awal.',
  auth: 'jwt',
  request: { body: jsonBody(updateMeBodySchema) },
  responses: { 200: jsonResponse('Profil setelah diubah.', userProfileSchema) },
});
