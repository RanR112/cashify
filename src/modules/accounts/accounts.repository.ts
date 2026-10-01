import type { PrismaClient } from '@prisma/client';
import { ownedBy } from '../../shared/utils/userScope.js';
import type { AccountsRepository } from './accounts.types.js';

export function createAccountsRepository(prisma: PrismaClient): AccountsRepository {
  return {
    listByUser: (userId) =>
      prisma.account.findMany({
        where: ownedBy(userId),
        select: { id: true, name: true, type: true, isDefault: true },
        // Akun default dulu, lalu menurut umur; `id` memutus seri supaya urutan stabil.
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
  };
}
