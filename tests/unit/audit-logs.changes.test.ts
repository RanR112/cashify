import { describe, expect, it } from 'vitest';
import { filterAuditChanges } from '../../src/modules/audit-logs/audit-logs.changes.js';

describe('filterAuditChanges', () => {
  it('transaksi: kunci di luar allowlist dibuang, before/after dipertahankan', () => {
    const changes = {
      before: {
        type: 'expense',
        amount: 1000,
        date: '2026-10-01',
        description: 'lama',
        category_id: '11111111-1111-4111-8111-111111111111',
        account_id: '22222222-2222-4222-8222-222222222222',
        ip_address: '203.0.113.7',
        phone: '+628123456789',
      },
      after: {
        type: 'expense',
        amount: 2000,
        date: '2026-10-01',
        description: 'baru',
        category_id: '11111111-1111-4111-8111-111111111111',
        account_id: '22222222-2222-4222-8222-222222222222',
        otp: '123456',
      },
    };

    expect(filterAuditChanges('transaction', changes)).toEqual({
      before: {
        type: 'expense',
        amount: 1000,
        date: '2026-10-01',
        description: 'lama',
        category_id: '11111111-1111-4111-8111-111111111111',
        account_id: '22222222-2222-4222-8222-222222222222',
      },
      after: {
        type: 'expense',
        amount: 2000,
        date: '2026-10-01',
        description: 'baru',
        category_id: '11111111-1111-4111-8111-111111111111',
        account_id: '22222222-2222-4222-8222-222222222222',
      },
    });
  });

  it('anggaran: categories dipertahankan utuh, kunci asing dibuang', () => {
    const categories = [{ category_id: '11111111-1111-4111-8111-111111111111', amount: 500000 }];
    expect(
      filterAuditChanges('budget', {
        after: { name: 'Anggaran Oktober', total_amount: 3000000, categories, auto_renew: true, secret: 'x' },
      }),
    ).toEqual({
      after: { name: 'Anggaran Oktober', total_amount: 3000000, categories, auto_renew: true },
    });
  });

  it('create hanya punya after; struktur yang tidak ada tidak ditambahkan', () => {
    expect(filterAuditChanges('transaction', { after: { amount: 25000, extra: true } })).toEqual({
      after: { amount: 25000 },
    });
  });

  it('semua kunci dibuang tetapi struktur before/after tetap ada', () => {
    expect(filterAuditChanges('transaction', { before: { ip_address: 'x' }, after: { otp: 'y' } })).toEqual({
      before: {},
      after: {},
    });
  });

  it('changes null, array, atau bukan objek menghasilkan null', () => {
    expect(filterAuditChanges('transaction', null)).toBeNull();
    expect(filterAuditChanges('transaction', 'bukan objek')).toBeNull();
    expect(filterAuditChanges('transaction', [1, 2])).toBeNull();
  });

  it('entity type tanpa allowlist menghasilkan null', () => {
    expect(filterAuditChanges('whatsapp_account', { after: { status: 'verified' } })).toBeNull();
  });
});