import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthRepository, ProvisionInput, UserRecord } from './auth.types.js';

export const DEFAULT_ACCOUNT_NAME = 'Tunai';

/** Baris users untuk id ini sudah ada (kemungkinan dibuat oleh permintaan lain yang bersamaan). */
export class UserAlreadyProvisionedError extends Error {
  constructor() {
    super('Baris users sudah ada');
    this.name = 'UserAlreadyProvisionedError';
  }
}

/** Kategori sistem belum di-seed. Pengguna tanpa kategori tidak boleh terbentuk. */
export class SystemCategoriesMissingError extends Error {
  constructor() {
    super('Kategori sistem kosong; jalankan `npm run seed`');
    this.name = 'SystemCategoriesMissingError';
  }
}

const userSelect = {
  id: true,
  fullName: true,
  avatarUrl: true,
  initialBalance: true,
  currency: true,
  timezone: true,
  locale: true,
  onboardingCompletedAt: true,
  createdAt: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

export function createAuthRepository(prisma: PrismaClient): AuthRepository {
  return {
    findUserById: (id) => prisma.user.findUnique({ where: { id }, select: userSelect }),

    async provisionNewUser(input: ProvisionInput): Promise<UserRecord> {
      try {
        return await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              id: input.id,
              fullName: input.fullName,
              avatarUrl: input.avatarUrl,
              initialBalance: input.initialBalance,
            },
            select: userSelect,
          });

          await tx.account.create({
            data: { userId: user.id, name: DEFAULT_ACCOUNT_NAME, type: 'cash', isDefault: true },
          });

          // Kategori sistem (user_id NULL) disalin menjadi milik pengguna ini.
          const templates = await tx.category.findMany({
            where: { userId: null, deletedAt: null },
            select: { name: true, slug: true, type: true, icon: true, color: true, keywords: true, sortOrder: true },
          });
          if (templates.length === 0) throw new SystemCategoriesMissingError();
          await tx.category.createMany({ data: templates.map((template) => ({ ...template, userId: user.id })) });

          return user;
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const target = error.meta?.target;
          const onUserKey =
            Array.isArray(target) ? target.includes('id') : typeof target === 'string' && target.includes('users');
          // Tabrakan di users.id = permintaan lain sudah memprovisi pengguna ini.
          if (onUserKey) throw new UserAlreadyProvisionedError();
        }
        throw error;
      }
    },
  };
}
