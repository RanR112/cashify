// Seed kategori sistem (user_id NULL). Aman dijalankan berulang.
//
// Kenapa bukan upsert: unique (user_id, slug) tidak bisa dipakai upsert saat user_id
// NULL. Jadi cari dulu per slug, lalu update atau create. Partial unique index
// `categories_system_slug_key` di database menjadi pengaman bila dua seed berjalan
// bersamaan.

import { PrismaClient } from '@prisma/client';
import { SYSTEM_CATEGORIES } from './seed-data.js';

const prisma = new PrismaClient();

async function main(): Promise<void> {
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

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
