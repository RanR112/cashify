import type { PrismaClient } from '@prisma/client';
import { visibleTo } from '../../shared/utils/userScope.js';
import type { CategoriesRepository } from './categories.types.js';

export function createCategoriesRepository(prisma: PrismaClient): CategoriesRepository {
  return {
    listVisibleTo: (userId, type) =>
      prisma.category.findMany({
        // `type` digabung lewat AND: tanpa itu, filter bisa keluar dari kurung OR dan
        // memperluas hasil ke kategori pengguna lain.
        where: { AND: [visibleTo(userId), ...(type ? [{ type }] : [])] },
        select: { id: true, userId: true, name: true, slug: true, type: true, icon: true, color: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      }),
  };
}
