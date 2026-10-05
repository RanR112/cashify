// Aturan bisnis service transaksi dengan repository palsu, tanpa database. Perilaku yang
// bergantung pada SQL (kunci baris, cursor, audit) diuji di tests/integration/transactions.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { createTransactionsService, toTransactionBody } from '../../src/modules/transactions/transactions.service.js';
import type {
  TransactionDetailRecord,
  TransactionRecord,
  TransactionsRepository,
  UpdateOutcome,
} from '../../src/modules/transactions/transactions.types.js';
import { AppError } from '../../src/shared/errors/AppError.js';
import { encodeCursor } from '../../src/shared/utils/cursor.js';
import { todayInJakarta } from '../../src/shared/utils/timezone.js';

const USER = '9f3c2a1e-6b4d-4e8a-9c1f-0d5e7a8b3c21';
const TX_ID = '11111111-1111-4111-8111-111111111111';
const FOOD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // expense
const SALARY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // income
const CASH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AUDIT = { ipAddress: null };

const UPDATED_AT = new Date('2026-09-28T05:12:35.123Z');

function detail(overrides: Partial<TransactionDetailRecord> = {}): TransactionDetailRecord {
  return {
    id: TX_ID,
    type: 'expense',
    amount: 25000,
    date: new Date('2026-09-28T00:00:00.000Z'),
    occurredAt: new Date('2026-09-27T17:00:00.000Z'),
    description: 'makan siang',
    source: 'manual',
    categoryId: FOOD,
    accountId: CASH,
    category: { id: FOOD, name: 'Makanan', icon: 'utensils', color: '#F97316' },
    account: { id: CASH, name: 'Tunai' },
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    sourceMessage: null,
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<TransactionsRepository> = {}): TransactionsRepository {
  const categories: Record<string, string> = { [FOOD]: 'expense', [SALARY]: 'income' };
  return {
    list: vi.fn(async () => []),
    findById: vi.fn(async () => detail()),
    create: vi.fn(async (_userId, data) => detail({ ...data, id: TX_ID }) as TransactionRecord),
    update: vi.fn(async (): Promise<UpdateOutcome> => ({ status: 'updated', record: detail() })),
    softDelete: vi.fn(async () => true),
    restore: vi.fn(async () => detail()),
    findBySourceMessage: vi.fn(async () => null),
    findLatestFromWhatsapp: vi.fn(async () => null),
    topCategoryIds: vi.fn(async () => []),
    findVisibleCategory: vi.fn(async (_userId, id) => {
      const type = categories[id];
      return type ? { id, type } : null;
    }),
    findOwnedAccount: vi.fn(async (_userId, id) => (id === CASH ? { id } : null)),
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

const createInput = (overrides = {}) => ({
  type: 'expense' as const,
  amount: 25000,
  category_id: FOOD,
  account_id: CASH,
  date: todayInJakarta(),
  ...overrides,
});

describe('create', () => {
  it('menyimpan transaksi dengan occurred_at awal hari Jakarta', async () => {
    const repository = fakeRepository();
    const service = createTransactionsService(repository);

    await service.create(USER, createInput({ date: '2026-09-28', description: 'makan siang' }), AUDIT);

    expect(repository.create).toHaveBeenCalledWith(
      USER,
      {
        type: 'expense',
        amount: 25000,
        categoryId: FOOD,
        accountId: CASH,
        occurredAt: new Date('2026-09-27T17:00:00.000Z'), // 00:00 WIB
        description: 'makan siang',
      },
      AUDIT,
    );
  });

  it('deskripsi yang tidak dikirim disimpan sebagai null', async () => {
    const repository = fakeRepository();
    await createTransactionsService(repository).create(USER, createInput(), AUDIT);
    expect(vi.mocked(repository.create).mock.calls[0]?.[1].description).toBeNull();
  });

  it('400 type_mismatch bila tipe kategori berbeda dengan tipe transaksi, dan tidak menulis apa pun', async () => {
    const repository = fakeRepository();
    const error = await rejection(
      createTransactionsService(repository).create(USER, createInput({ category_id: SALARY }), AUDIT),
    );
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([{ field: 'category_id', issue: 'type_mismatch' }]);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('404 bila kategori tidak ada atau bukan milik pemanggil', async () => {
    const repository = fakeRepository();
    const error = await rejection(
      createTransactionsService(repository).create(
        USER,
        createInput({ category_id: '00000000-0000-4000-8000-000000000000' }),
        AUDIT,
      ),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('404 bila akun bukan milik pemanggil', async () => {
    const repository = fakeRepository();
    const error = await rejection(
      createTransactionsService(repository).create(
        USER,
        createInput({ account_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
        AUDIT,
      ),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('update', () => {
  const stale = { updated_at: '2026-09-28T05:00:00.000Z' };
  const fresh = { updated_at: UPDATED_AT.toISOString() };

  it('404 bila transaksi tidak ada (dicek sebelum updated_at)', async () => {
    const repository = fakeRepository({ findById: vi.fn(async () => null) });
    const error = await rejection(createTransactionsService(repository).update(USER, TX_ID, { ...stale, amount: 1 }, AUDIT));
    expect(error.code).toBe('NOT_FOUND');
  });

  it('409 bila updated_at basi, sebelum validasi lain, dan tidak menulis apa pun', async () => {
    const repository = fakeRepository();
    // category_id yang tak ada akan 404 bila validasi berjalan lebih dulu.
    const error = await rejection(
      createTransactionsService(repository).update(
        USER,
        TX_ID,
        { ...stale, category_id: '00000000-0000-4000-8000-000000000000' },
        AUDIT,
      ),
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual([{ field: 'updated_at', issue: 'stale' }]);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('409 bila repository melaporkan konflik (balapan setelah jalur cepat)', async () => {
    const repository = fakeRepository({ update: vi.fn(async (): Promise<UpdateOutcome> => ({ status: 'conflict' })) });
    const error = await rejection(createTransactionsService(repository).update(USER, TX_ID, { ...fresh, amount: 1 }, AUDIT));
    expect(error.code).toBe('CONFLICT');
  });

  it('404 bila repository melaporkan transaksi hilang (dihapus di tengah jalan)', async () => {
    const repository = fakeRepository({ update: vi.fn(async (): Promise<UpdateOutcome> => ({ status: 'not_found' })) });
    const error = await rejection(createTransactionsService(repository).update(USER, TX_ID, { ...fresh, amount: 1 }, AUDIT));
    expect(error.code).toBe('NOT_FOUND');
  });

  it('400 bila hanya type berubah dan bentrok dengan kategori lama', async () => {
    const repository = fakeRepository();
    const error = await rejection(createTransactionsService(repository).update(USER, TX_ID, { ...fresh, type: 'income' }, AUDIT));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([{ field: 'category_id', issue: 'type_mismatch' }]);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('boleh mengubah type dan category_id bersamaan ke pasangan yang cocok', async () => {
    const repository = fakeRepository();
    await createTransactionsService(repository).update(USER, TX_ID, { ...fresh, type: 'income', category_id: SALARY }, AUDIT);
    expect(vi.mocked(repository.update).mock.calls[0]?.[3]).toEqual({ type: 'income', categoryId: SALARY });
  });

  it('kategori dan akun yang tidak berubah tidak diperiksa ulang', async () => {
    const repository = fakeRepository();
    await createTransactionsService(repository).update(USER, TX_ID, { ...fresh, category_id: FOOD, account_id: CASH, amount: 5 }, AUDIT);
    expect(repository.findVisibleCategory).not.toHaveBeenCalled();
    expect(repository.findOwnedAccount).not.toHaveBeenCalled();
  });

  it('tanggal yang sama tidak menyentuh occurred_at; tanggal baru memindahkannya ke awal hari Jakarta', async () => {
    const repository = fakeRepository();
    const service = createTransactionsService(repository);

    await service.update(USER, TX_ID, { ...fresh, date: '2026-09-28' }, AUDIT);
    expect(vi.mocked(repository.update).mock.calls[0]?.[3]).toEqual({});

    await service.update(USER, TX_ID, { ...fresh, date: '2026-09-20' }, AUDIT);
    expect(vi.mocked(repository.update).mock.calls[1]?.[3]).toEqual({ occurredAt: new Date('2026-09-19T17:00:00.000Z') });
  });

  it('description null mengosongkan deskripsi; tidak dikirim berarti tidak diubah', async () => {
    const repository = fakeRepository();
    const service = createTransactionsService(repository);

    await service.update(USER, TX_ID, { ...fresh, description: null }, AUDIT);
    expect(vi.mocked(repository.update).mock.calls[0]?.[3]).toEqual({ description: null });

    await service.update(USER, TX_ID, { ...fresh, amount: 1 }, AUDIT);
    expect(vi.mocked(repository.update).mock.calls[1]?.[3]).not.toHaveProperty('description');
  });
});

describe('list', () => {
  const rows = (count: number): TransactionRecord[] =>
    Array.from({ length: count }, (_, i) =>
      detail({ id: `00000000-0000-4000-8000-00000000000${i}`, date: new Date(`2026-09-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`) }),
    );

  it('meminta limit + 1 baris, memotong ke limit, dan membuat next_cursor dari baris terakhir halaman', async () => {
    const repository = fakeRepository({ list: vi.fn(async () => rows(3)) });
    const result = await createTransactionsService(repository).list(USER, { limit: 2 });

    expect(vi.mocked(repository.list).mock.calls[0]?.[1].limit).toBe(3);
    expect(result.data).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(JSON.parse(Buffer.from(result.next_cursor as string, 'base64url').toString())).toEqual({
      d: '2026-09-19',
      i: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('halaman terakhir: has_more false dan next_cursor null', async () => {
    const repository = fakeRepository({ list: vi.fn(async () => rows(2)) });
    const result = await createTransactionsService(repository).list(USER, { limit: 2 });
    expect(result).toMatchObject({ has_more: false, next_cursor: null });
    expect(result.data).toHaveLength(2);
  });

  it('daftar kosong', async () => {
    const result = await createTransactionsService(fakeRepository()).list(USER, { limit: 20 });
    expect(result).toEqual({ data: [], next_cursor: null, has_more: false });
  });

  it('cursor dibaca menjadi posisi (date, id) dan filter diteruskan dalam nama kolom', async () => {
    const repository = fakeRepository();
    const cursor = encodeCursor({ d: '2026-09-19', i: '00000000-0000-4000-8000-000000000001' });
    await createTransactionsService(repository).list(USER, {
      limit: 20,
      cursor,
      from: '2026-09-01',
      type: 'expense',
      category_id: FOOD,
      account_id: CASH,
      q: 'makan',
    });

    expect(vi.mocked(repository.list).mock.calls[0]?.[1]).toMatchObject({
      after: { date: '2026-09-19', id: '00000000-0000-4000-8000-000000000001' },
      filters: { from: '2026-09-01', type: 'expense', categoryId: FOOD, accountId: CASH, q: 'makan' },
    });
  });

  it.each([
    ['bukan base64url', '!!!'],
    ['bukan JSON', Buffer.from('bukan json').toString('base64url')],
    ['bentuk salah', encodeCursor({ d: 'kemarin', i: 'x' })],
  ])('400 untuk cursor %s', async (_name, cursor) => {
    const repository = fakeRepository();
    const error = await rejection(createTransactionsService(repository).list(USER, { limit: 20, cursor }));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(repository.list).not.toHaveBeenCalled();
  });
});

describe('get, remove, restore', () => {
  it('get: 404 bila tidak ada', async () => {
    const repository = fakeRepository({ findById: vi.fn(async () => null) });
    expect((await rejection(createTransactionsService(repository).get(USER, TX_ID))).code).toBe('NOT_FOUND');
  });

  it('get: source_message terisi hanya untuk transaksi WhatsApp', async () => {
    const sourceMessage = { body: 'tadi makan siang 25 ribu', createdAt: new Date('2026-09-28T05:12:33.000Z') };
    const whatsapp = fakeRepository({ findById: vi.fn(async () => detail({ source: 'whatsapp', sourceMessage })) });
    expect((await createTransactionsService(whatsapp).get(USER, TX_ID)).source_message).toEqual({
      body: 'tadi makan siang 25 ribu',
      received_at: '2026-09-28T05:12:33.000Z',
    });

    // Sumber lain tidak pernah membocorkan pesan, walau sourceMessage entah bagaimana terisi.
    const manual = fakeRepository({ findById: vi.fn(async () => detail({ source: 'manual', sourceMessage })) });
    expect((await createTransactionsService(manual).get(USER, TX_ID)).source_message).toBeNull();

    // WhatsApp tetapi pesannya sudah hilang (FK SET NULL).
    const orphan = fakeRepository({ findById: vi.fn(async () => detail({ source: 'whatsapp', sourceMessage: null })) });
    expect((await createTransactionsService(orphan).get(USER, TX_ID)).source_message).toBeNull();
  });

  it('remove: 404 bila tidak ada atau sudah dihapus', async () => {
    const repository = fakeRepository({ softDelete: vi.fn(async () => false) });
    expect((await rejection(createTransactionsService(repository).remove(USER, TX_ID, AUDIT))).code).toBe('NOT_FOUND');
  });

  it('restore: 404 bila belum dihapus', async () => {
    const repository = fakeRepository({ restore: vi.fn(async () => null) });
    expect((await rejection(createTransactionsService(repository).restore(USER, TX_ID, AUDIT))).code).toBe('NOT_FOUND');
  });
});

describe('toTransactionBody', () => {
  it('memetakan record ke bentuk API.md: snake_case, tanggal kalender, timestamp ISO', () => {
    expect(toTransactionBody(detail())).toEqual({
      id: TX_ID,
      type: 'expense',
      amount: 25000,
      date: '2026-09-28',
      description: 'makan siang',
      source: 'manual',
      category: { id: FOOD, name: 'Makanan', icon: 'utensils', color: '#F97316' },
      account: { id: CASH, name: 'Tunai' },
      created_at: '2026-09-28T05:12:35.123Z',
      updated_at: '2026-09-28T05:12:35.123Z',
    });
  });

  it('tidak membocorkan field internal (user_id, occurred_at, deleted_at)', () => {
    const keys = Object.keys(toTransactionBody(detail()));
    expect(keys).not.toContain('user_id');
    expect(keys).not.toContain('occurred_at');
    expect(keys).not.toContain('deleted_at');
  });
});

describe('createFromWhatsapp', () => {
  const MESSAGE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const input = (overrides = {}) => ({
    type: 'expense' as const,
    amount: 25000,
    categoryId: FOOD,
    accountId: CASH,
    date: '2026-09-28',
    description: 'makan siang',
    messageTime: new Date('2026-09-28T05:12:35.000Z'), // 12:12 WIB
    sourceMessageId: MESSAGE,
    ...overrides,
  });

  it('sumber whatsapp, pesan asal tercatat, dan audit oleh aktor whatsapp', async () => {
    const repository = fakeRepository();
    await createTransactionsService(repository).createFromWhatsapp(USER, input());

    expect(repository.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ source: 'whatsapp', sourceMessageId: MESSAGE, amount: 25000, description: 'makan siang' }),
      { ipAddress: null, actor: 'whatsapp' },
    );
  });

  it('tanggal hari pesan: occurred_at memakai jam pesan', async () => {
    const repository = fakeRepository();
    await createTransactionsService(repository).createFromWhatsapp(USER, input());
    expect(vi.mocked(repository.create).mock.calls[0]?.[1].occurredAt).toEqual(new Date('2026-09-28T05:12:35.000Z'));
  });

  it('tanggal lain (kemarin): occurred_at awal hari Jakarta tanggal itu', async () => {
    const repository = fakeRepository();
    await createTransactionsService(repository).createFromWhatsapp(USER, input({ date: '2026-09-27' }));
    expect(vi.mocked(repository.create).mock.calls[0]?.[1].occurredAt).toEqual(new Date('2026-09-26T17:00:00.000Z'));
  });

  it('tipe kategori tidak cocok ditolak dan tidak menulis apa pun', async () => {
    const repository = fakeRepository();
    const error = await rejection(
      createTransactionsService(repository).createFromWhatsapp(USER, input({ categoryId: SALARY })),
    );
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(repository.create).not.toHaveBeenCalled();
  });
});
