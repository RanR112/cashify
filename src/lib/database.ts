import { PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;

/**
 * Klien Prisma tunggal, dibuat saat dipakai pertama kali supaya mengimpor berkas ini
 * (dan app.ts) tidak butuh DATABASE_URL.
 */
export function getPrisma(): PrismaClient {
  return (client ??= new PrismaClient());
}
