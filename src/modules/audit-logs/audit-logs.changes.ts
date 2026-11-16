// Penyaring `changes` audit. Fungsi murni: tidak mengimpor Prisma, Express, atau repository.
//
// transactions.repository.ts menulis kunci `date` (bukan `occurred_at`), jadi allowlist
// transaksi memakai `date`. Kunci di luar allowlist dibuang agar ip_address, nomor telepon,
// OTP, atau detail internal lain tidak pernah sampai ke klien.

import type { AuditEntityType, FilteredAuditChanges } from './audit-logs.types.js';

const ALLOWLIST: Record<AuditEntityType, ReadonlySet<string>> = {
  transaction: new Set(['type', 'amount', 'date', 'description', 'category_id', 'account_id']),
  budget: new Set(['name', 'total_amount', 'categories', 'auto_renew']),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function filterSide(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
}

/**
 * Null bila `changes` bukan objek (termasuk null). Selain itu selalu mengembalikan objek,
 * dengan `before`/`after` yang ada di sumber dipertahankan walau seluruh kuncinya dibuang.
 */
export function filterAuditChanges(entityType: string, changes: unknown): FilteredAuditChanges | null {
  const allowed = ALLOWLIST[entityType as AuditEntityType];
  if (!allowed || !isPlainObject(changes)) return null;

  const result: FilteredAuditChanges = {};
  const before = filterSide(changes.before, allowed);
  const after = filterSide(changes.after, allowed);
  if (before !== undefined) result.before = before;
  if (after !== undefined) result.after = after;

  return result;
}