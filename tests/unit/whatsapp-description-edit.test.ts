// Ralat catatan saat pending (whatsapp.conversation.ts): "catat ... aja" hanya mengubah
// deskripsi, bukan membuat transaksi baru atau menanyakan nominal lagi. Tanpa Postgres/Redis;
// semua port diganti benda palsu seperti whatsapp-llm.test.ts.

import { describe, expect, it } from 'vitest';
import { createConversation, type Pending } from '../../src/modules/whatsapp/whatsapp.conversation.js';
import type {
  ConversationCategory,
  NewWhatsappTransaction,
  ReplyRequest,
} from '../../src/modules/whatsapp/whatsapp.types.js';

const CATEGORIES: ConversationCategory[] = [
  { id: 'cat-food', slug: 'food', name: 'Makanan', type: 'expense', keywords: ['makan', 'kopi', 'nasi'] },
  { id: 'cat-transport', slug: 'transport', name: 'Transportasi', type: 'expense', keywords: ['bensin', 'grab'] },
];

const USER_ID = 'u-1';
const MESSAGE_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

interface Harness {
  conversation: ReturnType<typeof createConversation>;
  replies: string[];
  pending: () => Pending | null;
  created: NewWhatsappTransaction[];
}

function harness(): Harness {
  const replies: string[] = [];
  const created: NewWhatsappTransaction[] = [];
  const store = new Map<string, Pending>();

  const conversation = createConversation({
    pending: {
      get: async () => store.get(USER_ID) ?? null,
      set: async (_userId, value) => void store.set(USER_ID, value),
      clear: async () => void store.delete(USER_ID),
    },
    categories: { list: async () => CATEGORIES },
    accounts: { defaultAccountId: async () => 'acc-1' },
    transactions: {
      createFromWhatsapp: async (_userId, input) => {
        created.push(input);
        const category = CATEGORIES.find((candidate) => candidate.id === input.categoryId)!;
        return {
          id: 'tx-1',
          type: input.type,
          amount: input.amount,
          date: input.date,
          description: input.description,
          category: { id: category.id, name: category.name },
        };
      },
      findBySourceMessage: async () => null,
      latestFromWhatsapp: async () => null,
      topCategoryIds: async () => [],
      remove: async () => null,
    },
    reply: async (request: ReplyRequest) => void replies.push(request.text),
  });

  return { conversation, replies, pending: () => store.get(USER_ID) ?? null, created };
}

const receive = (text: string) => ({
  userId: USER_ID,
  messageId: MESSAGE_ID,
  text,
  sentAt: new Date('2026-11-10T03:00:00Z'),
  replyTo: '628123456789@c.us',
});

const amountPending = (pending: Pending | null): Extract<Pending, { kind: 'amount' }> => {
  expect(pending?.kind).toBe('amount');
  return pending as Extract<Pending, { kind: 'amount' }>;
};

const confirmationPending = (pending: Pending | null): Extract<Pending, { kind: 'confirmation' }> => {
  expect(pending?.kind).toBe('confirmation');
  return pending as Extract<Pending, { kind: 'confirmation' }>;
};

describe('ralat catatan saat pending', () => {
  it('pending nominal: deskripsi berubah, nominal/kategori/tanggal/sumber tetap', async () => {
    const h = harness();
    await h.conversation.handle(receive('beli nasi goreng porsi besar'));

    const before = amountPending(h.pending());
    await h.conversation.handle(receive('catat "nasi goreng + es teh" aja'));

    const after = amountPending(h.pending());
    expect(after.draft.description).toBe('nasi goreng + es teh');
    expect(after.draft.type).toBe(before.draft.type);
    expect(after.draft.date).toBe(before.draft.date);
    expect(after.draft.sourceMessageId).toBe(before.draft.sourceMessageId);
    expect(after.draft.categorySlug).toBe(before.draft.categorySlug);
    expect(h.replies[1]).toContain('"nasi goreng + es teh" masuk Makanan.');
    expect(h.replies[1]).toContain('Berapa nominalnya?');

    await h.conversation.handle(receive('20k'));
    expect(confirmationPending(h.pending()).draft.description).toBe('nasi goreng + es teh');
    expect(h.replies[2]).toContain('Rp20.000');
    expect(h.replies[2]).toContain('"nasi goreng + es teh"');

    await h.conversation.handle(receive('ya'));
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.amount).toBe(20_000);
    expect(h.created[0]!.description).toBe('nasi goreng + es teh');
  });

  it('pending konfirmasi: nominal tidak berubah dan konfirmasi ditampilkan ulang', async () => {
    const h = harness();
    await h.conversation.handle(receive('nasi goreng porsi besar 20k'));

    const before = confirmationPending(h.pending());
    await h.conversation.handle(receive('catat "nasi goreng + es teh" aja'));

    const after = confirmationPending(h.pending());
    expect(after.draft.description).toBe('nasi goreng + es teh');
    expect(after.draft.amount).toBe(before.draft.amount);
    expect(after.draft.categorySlug).toBe(before.draft.categorySlug);
    expect(after.draft.type).toBe(before.draft.type);
    expect(after.draft.date).toBe(before.draft.date);
    expect(after.draft.sourceMessageId).toBe(before.draft.sourceMessageId);
    expect(h.replies[1]).toContain('Rp20.000');
    expect(h.replies[1]).toContain('"nasi goreng + es teh"');
    expect(h.replies[1]).toContain('YA untuk simpan');

    await h.conversation.handle(receive('ya'));
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.amount).toBe(20_000);
    expect(h.created[0]!.description).toBe('nasi goreng + es teh');
  });

  it('pesan "catat ... <nominal>" tetap transaksi baru, bukan ralat', async () => {
    const h = harness();
    await h.conversation.handle(receive('nasi goreng porsi besar 20k'));
    expect(confirmationPending(h.pending()).draft.amount).toBe(20_000);

    await h.conversation.handle(receive('catat nasi goreng + es teh 25k'));

    const after = confirmationPending(h.pending());
    expect(after.draft.amount).toBe(25_000);
    expect(after.draft.description).toBe('nasi goreng + es teh');
    expect(h.replies[1]).toContain('Rp25.000');
  });

  it('tanpa pending, "catat ..." tetap menjadi transaksi biasa yang menanyakan nominal', async () => {
    const h = harness();
    await h.conversation.handle(receive('catat nasi goreng + es teh'));

    const pending = amountPending(h.pending());
    expect(pending.draft.description).toBe('nasi goreng + es teh');
    expect(pending.draft.categorySlug).toBe('food');
    expect(h.replies[0]).toContain('"nasi goreng + es teh" masuk Makanan.');
  });
});
