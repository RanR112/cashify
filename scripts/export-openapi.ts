// Mengekspor dokumen OpenAPI ke claude/openapi.json. Jalankan: npm run openapi

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildOpenApiDocument } from '../src/config/openapi.js';

const target = resolve(import.meta.dirname, '../claude/openapi.json');
const document = buildOpenApiDocument();

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

const operations = Object.values(document.paths ?? {}).reduce(
  (total, item) => total + Object.keys(item).filter((key) => key !== 'parameters').length,
  0,
);
console.log(`Tertulis: ${target} (${operations} operasi)`);
