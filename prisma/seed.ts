// Seed: kategori sistem (user_id NULL) lalu pengguna demo beserta transaksinya.
// Aman dijalankan berulang.
//
//   npm run seed         kategori sistem + pengguna demo; transaksi demo dilewati bila sudah ada
//   npm run seed:reset   sama, tetapi data demo dihapus dulu lalu diisi ulang (tanggal segar)
//
// Kategori sistem: bukan upsert karena unique (user_id, slug) tidak bisa dipakai upsert saat
// user_id NULL. Jadi cari dulu per slug, lalu update atau create. Partial unique index
// `categories_system_slug_key` di database menjadi pengaman bila dua seed berjalan
// bersamaan.
//
// Pengguna demo dibuat lewat Supabase Auth (butuh jaringan dan kunci Supabase). Kategori
// sistem di-commit lebih dulu, jadi kegagalan langkah demo tidak membatalkannya.

import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { createSupabaseAuthProvider } from '../src/lib/auth.js';
import { SYSTEM_CATEGORIES } from './seed-data.js';
import { DEMO_EMAIL, DEMO_PASSWORD } from './seed-demo-data.js';
import { seedDemo } from './seed-demo.js';

// Hanya yang dibutuhkan seed; env.ts milik aplikasi menuntut semuanya (OpenWA, Redis, dst.).
const seedEnvSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DEMO_EMAIL: z.email().default(DEMO_EMAIL),
  DEMO_PASSWORD: z.string().min(8).max(72).default(DEMO_PASSWORD),
});

const prisma = new PrismaClient();

async function seedSystemCategories(): Promise<void> {
  let created = 0;
  let updated = 0;

  await prisma.$transaction(async (tx) => {
    for (const category of SYSTEM_CATEGORIES) {
      const existing = await tx.category.findFirst({
        where: { userId: null, slug: category.slug },
        select: { id: true },
      });

      if (existing) {
        await tx.category.update({
          where: { id: existing.id },
          data: {
            name: category.name,
            type: category.type,
            icon: category.icon,
            color: category.color,
            keywords: category.keywords,
            sortOrder: category.sortOrder,
            deletedAt: null,
          },
        });
        updated += 1;
      } else {
        await tx.category.create({ data: { ...category, userId: null } });
        created += 1;
      }
    }
  });

  console.log(`Seed kategori sistem selesai: ${created} dibuat, ${updated} diperbarui.`);
}

async function seedDemoUser(reset: boolean): Promise<void> {
  const parsed = seedEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Variabel lingkungan untuk seed demo tidak valid:\n${problems}`);
  }
  const env = parsed.data;

  const provider = createSupabaseAuthProvider({
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });

  if (reset) console.log('Mode reset: data demo dihapus lebih dulu.');
  let result;
  try {
    result = await seedDemo(prisma, provider, { email: env.DEMO_EMAIL, password: env.DEMO_PASSWORD, reset });
  } catch (error) {
    console.error(
      `Seed demo gagal. Bila Supabase menolak ${env.DEMO_EMAIL} (misalnya domain tidak valid), ` +
        'setel DEMO_EMAIL di .env ke alamat lain.',
    );
    throw error;
  }

  if (result.seededTransactions) {
    console.log(
      `Seed demo selesai untuk ${env.DEMO_EMAIL}: ${result.transactions} transaksi ` +
        `(${result.deletedTransactions} di-soft-delete), ${result.whatsappMessages} pesan WhatsApp.`,
    );
  } else {
    console.log(
      `Pengguna demo ${env.DEMO_EMAIL} sudah punya ${result.existingTransactions} transaksi; dilewati. ` +
        'Pakai `npm run seed:reset` untuk membuat ulang dengan tanggal terbaru.',
    );
  }
}

async function main(): Promise<void> {
  await seedSystemCategories();
  await seedDemoUser(process.argv.includes('--reset'));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
