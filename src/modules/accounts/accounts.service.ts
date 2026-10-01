import type { AccountBody, AccountsRepository } from './accounts.types.js';

export function createAccountsService(repository: AccountsRepository) {
  return {
    async list(userId: string): Promise<{ data: AccountBody[] }> {
      const accounts = await repository.listByUser(userId);
      return {
        data: accounts.map((account) => ({
          id: account.id,
          name: account.name,
          type: account.type as AccountBody['type'],
          is_default: account.isDefault,
        })),
      };
    },
  };
}

export type AccountsService = ReturnType<typeof createAccountsService>;
