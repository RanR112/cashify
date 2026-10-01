// Menyiapkan database untuk test integrasi, sekali per `vitest run`.
//
// Alamat default cocok dengan service `postgres-test` di docker-compose.yml, jadi cukup
// `docker compose up -d postgres-test` lalu `npm run test`. Bila database tidak terjangkau,
// suite integrasi dilewati (bukan gagal) dan test unit tetap berjalan.

import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import type { TestProject } from 'vitest/node';
import { SYSTEM_CATEGORIES } from '../../prisma/seed-data.js';
import { assertSafeTestDbUrl, DEFAULT_TEST_DATABASE_URL } from '../helpers/testDb.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL database test yang sudah termigrasi dan berisi kategori sistem; '' bila tidak tersedia. */
    testDbUrl: string;
  }
}

async function isReachable(url: string): Promise<boolean> {
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  assertSafeTestDbUrl(url);

  if (!(await isReachable(url))) {
    console.warn(
      '\n[test] Postgres test tidak terjangkau; test integrasi dilewati. ' +
        'Nyalakan dengan: docker compose up -d postgres-test\n',
    );
    project.provide('testDbUrl', '');
    return;
  }

  // Migrasi lewat `prisma migrate deploy`, sama seperti skema produksi (aturan 11).
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    for (const category of SYSTEM_CATEGORIES) {
      const existing = await prisma.category.findFirst({ where: { userId: null, slug: category.slug } });
      if (!existing) await prisma.category.create({ data: { ...category, userId: null } });
    }
  } finally {
    await prisma.$disconnect();
  }

  project.provide('testDbUrl', url);
}
