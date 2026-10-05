// Menyiapkan database untuk test integrasi, sekali per `vitest run`.
//
// Alamat default cocok dengan service `postgres-test` di docker-compose.yml, jadi cukup
// `docker compose up -d postgres-test` lalu `npm run test`. Bila database tidak terjangkau,
// suite integrasi dilewati (bukan gagal) dan test unit tetap berjalan.

import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { TestProject } from 'vitest/node';
import { SYSTEM_CATEGORIES } from '../../prisma/seed-data.js';
import { assertSafeTestDbUrl, DEFAULT_TEST_DATABASE_URL } from '../helpers/testDb.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL database test yang sudah termigrasi dan berisi kategori sistem; '' bila tidak tersedia. */
    testDbUrl: string;
    /** URL Redis yang terjangkau untuk test lock/antrean; '' bila tidak tersedia. */
    testRedisUrl: string;
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

export const DEFAULT_TEST_REDIS_URL = 'redis://localhost:6379';

async function isRedisReachable(url: string): Promise<boolean> {
  // Tanpa retry: Redis yang mati harus ketahuan dalam sekejap, bukan menggantung.
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

export default async function setup(project: TestProject): Promise<void> {
  await setupRedis(project);
  await setupPostgres(project);
}

/**
 * Redis dipakai test lock dan antrean. Test memakai id pengguna acak dan awalan antrean unik,
 * jadi aman dijalankan pada Redis pengembangan (tidak ada FLUSH); tidak ada yang dihapus selain
 * kunci miliknya sendiri.
 */
async function setupRedis(project: TestProject): Promise<void> {
  const url = process.env.TEST_REDIS_URL ?? DEFAULT_TEST_REDIS_URL;
  if (await isRedisReachable(url)) {
    project.provide('testRedisUrl', url);
    return;
  }
  console.warn(
    '\n[test] Redis tidak terjangkau; test lock dan antrean dilewati. ' +
      'Nyalakan dengan: docker compose up -d redis\n',
  );
  project.provide('testRedisUrl', '');
}

async function setupPostgres(project: TestProject): Promise<void> {
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
