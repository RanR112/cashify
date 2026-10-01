// `z` yang sudah ditambal dengan `.openapi()`. Semua berkas skema mengimpor `z` dari sini,
// bukan dari 'zod', supaya penambalan pasti terjadi sebelum skema pertama dibuat.

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export { z };
