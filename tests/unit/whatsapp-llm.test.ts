// Cadangan LLM di alur percakapan (ARCHITECTURE.md Bagian 7 tahap 5). Yang diuji di sini adalah port
// `llm`: kapan dipanggil, apa yang boleh disarankan, dan apa yang tetap tidak boleh — nominal dan
// tanggal selalu dari regex, kategori harus benar-benar ada, dan tanpa port ini perilakunya persis
// seperti sebelum LLM. Tanpa Postgres dan Redis: semua port diganti benda palsu, `reply` hanya
// menampung teks yang akan dikirim.

import { describe, expect, it } from 'vitest';
import { createConversation, type Pending } from '../../src/modules/whatsapp/whatsapp.conversation.js';
import type {
  ConversationCategory,
  ConversationLlm,
  ConversationLlmHint,
  NewWhatsappTransaction,
  ReplyRequest,
} from '../../src/modules/whatsapp/whatsapp.types.js';

const CATEGORIES: ConversationCategory[] = [
  { id: 'cat-food', slug: 'food', name: 'Makanan', type: 'expense', keywords: ['makan', 'kopi', 'nasi'] },
  { id: 'cat-transport', slug: 'transport', name: 'Transportasi', type: 'expense', keywords: ['bensin', 'grab'] },
  { id: 'cat-salary', slug: 'salary', name: 'Gaji', type: 'income', keywords: ['gaji'] },
];

const USER_ID = 'u-1';
const MESSAGE_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const hint = (patch: Partial<ConversationLlmHint> = {}): ConversationLlmHint => ({
  intent: 'CREATE_TRANSACTION',
  type: 'expense',
  categoryHint: '',
  description: '',
  confidence: 0.9,
  ...patch,
});

interface Harness {
  conversation: ReturnType<typeof createConversation>;
  /** Teks balasan yang dikirim, urut. */
  replies: string[];
  pending: () => Pending | null;
  /** Transaksi yang benar-benar disimpan. */
  created: NewWhatsappTransaction[];
  /** Teks yang pernah dikirim ke LLM untuk klasifikasi. */
  asked: string[];
  /** Teks yang pernah dikirim ke LLM untuk jawaban bebas. */
  answered: string[];
}

function harness(
  hintImpl?: (text: string) => Promise<ConversationLlmHint | null>,
  answerImpl?: (text: string) => Promise<string | null>,
): Harness {
  const replies: string[] = [];
  const created: NewWhatsappTransaction[] = [];
  const store = new Map<string, Pending>();
  const asked: string[] = [];
  const answered: string[] = [];

  const llm: ConversationLlm | undefined = (hintImpl || answerImpl) && {
    hint: async (text) => {
      asked.push(text);
      return hintImpl ? hintImpl(text) : null;
    },
    ...(answerImpl && {
      answer: async (text) => {
        answered.push(text);
        return answerImpl(text);
      },
    }),
  };

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
    ...(llm && { llm }),
  });

  return { conversation, replies, pending: () => store.get(USER_ID) ?? null, created, asked, answered };
}

const receive = (text: string) => ({
  userId: USER_ID,
  messageId: MESSAGE_ID,
  text,
  sentAt: new Date('2026-11-10T03:00:00Z'),
  replyTo: '628123456789@c.us',
});

const ASK_CATEGORY = 'Kategorinya apa?';
const NOT_UNDERSTOOD = 'Belum paham maksudnya';

describe('cadangan kategori: dipakai hanya saat kamus gagal', () => {
  it('tanpa port LLM, kategori asing tetap ditanya', async () => {
    const h = harness();
    await h.conversation.handle(receive('jajan di warteg 25rb'));

    expect(h.replies[0]).toContain(ASK_CATEGORY);
    expect(h.pending()?.kind).toBe('category');
    expect(h.asked).toEqual([]);
  });

  it('hint kategori yang cocok langsung meminta konfirmasi, tanpa bertanya', async () => {
    const h = harness(async () => hint({ categoryHint: 'makanan', description: 'jajan di warteg' }));
    await h.conversation.handle(receive('jajan di warteg 25rb'));

    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toContain('Rp25.000');
    expect(h.replies[0]).toContain('Makanan');
    expect(h.replies[0]).toContain('YA untuk simpan');
    expect(h.pending()?.kind).toBe('confirmation');
    expect(h.asked).toEqual(['jajan di warteg 25rb']);
  });

  it('hint dicocokkan lewat kata kunci kamus maupun nama kategori', async () => {
    const keyword = harness(async () => hint({ categoryHint: 'kopi' }));
    await keyword.conversation.handle(receive('jajan di warteg 25rb'));
    expect(keyword.replies[0]).toContain('Makanan');

    const byName = harness(async () => hint({ categoryHint: 'Transportasi' }));
    await byName.conversation.handle(receive('jajan di warteg 25rb'));
    expect(byName.replies[0]).toContain('Transportasi');
  });

  it('hint yang tidak ada kategorinya diabaikan, bukan menciptakan kategori baru', async () => {
    const h = harness(async () => hint({ categoryHint: 'kasino' }));
    await h.conversation.handle(receive('jajan di warteg 25rb'));

    expect(h.replies[0]).toContain(ASK_CATEGORY);
    expect(h.pending()?.kind).toBe('category');
  });

  it('hint kategori bertipe lain tidak dipakai', async () => {
    // "gaji" hanya ada sebagai kategori pemasukan; pesan ini pengeluaran.
    const h = harness(async () => hint({ categoryHint: 'gaji' }));
    await h.conversation.handle(receive('jajan di warteg 25rb'));

    expect(h.replies[0]).toContain(ASK_CATEGORY);
  });

  it('category_hint kosong diabaikan', async () => {
    const h = harness(async () => hint({ categoryHint: '   ' }));
    await h.conversation.handle(receive('jajan di warteg 25rb'));

    expect(h.replies[0]).toContain(ASK_CATEGORY);
  });

  it('jawaban kategori yang tidak dikenali kamus dibantu LLM', async () => {
    const h = harness(async (text) => (text.includes('warteg') ? null : hint({ categoryHint: 'makanan' })));
    await h.conversation.handle(receive('jajan di warteg 25rb'));
    expect(h.pending()?.kind).toBe('category');

    await h.conversation.handle(receive('jajan di kedai'));

    expect(h.pending()?.kind).toBe('confirmation');
    expect(h.replies[1]).toContain('Rp25.000');
    expect(h.replies[1]).toContain('Makanan');
  });

  it('nominal tetap dari regex, bukan dari LLM', async () => {
    const h = harness(async () => hint({ categoryHint: 'makanan' }));
    await h.conversation.handle(receive('ngopi sama temen 25rb'));
    expect(h.replies[0]).toContain('Rp25.000');

    await h.conversation.handle(receive('ya'));

    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.amount).toBe(25_000);
  });
});

describe('cadangan intent: dipakai hanya saat regex tidak memutuskan', () => {
  it('intent dari LLM dipakai saat parseMessage tidak memutuskan', async () => {
    const h = harness(async () => hint({ intent: 'QUERY' }));
    await h.conversation.handle(receive('berapa sisa uangku bulan ini'));

    expect(h.replies[0]).toContain('belum tersedia lewat WhatsApp');
    expect(h.asked).toEqual(['berapa sisa uangku bulan ini']);
  });

  it('jawaban UNKNOWN dari LLM tidak memicu panggilan kedua', async () => {
    const h = harness(async () => hint({ intent: 'UNKNOWN' }));
    await h.conversation.handle(receive('berapa sisa uangku bulan ini'));

    expect(h.replies[0]).toContain(NOT_UNDERSTOOD);
    expect(h.asked).toHaveLength(1);
  });

  it('intent DELETE dari LLM mengikuti alur hapus, bukan pesan tidak paham', async () => {
    const h = harness(async () => hint({ intent: 'DELETE' }));
    await h.conversation.handle(receive('tolong hapus yang tadi dong'));

    expect(h.replies[0]).not.toContain(NOT_UNDERSTOOD);
  });

  it('hint null (timeout atau galat) berperilaku seperti tanpa LLM', async () => {
    const h = harness(async () => null);
    await h.conversation.handle(receive('berapa sisa uangku bulan ini'));

    expect(h.replies[0]).toContain(NOT_UNDERSTOOD);
  });

  it('command tak dikenal tidak pernah dikirim ke LLM', async () => {
    const h = harness(async () => hint({ intent: 'QUERY' }));
    await h.conversation.handle(receive('/entah'));

    expect(h.asked).toEqual([]);
    expect(h.replies[0]).toContain(NOT_UNDERSTOOD);
  });
});

describe('batas LLM: nominal selalu dari regex', () => {
  it('pertanyaan nominal tidak melibatkan LLM sama sekali', async () => {
    // Kategori sudah dikenali, nominal belum: yang kurang hanya nominal, dan itu selalu regex.
    const h = harness(async () => hint({ categoryHint: 'makanan', intent: 'QUERY' }));
    await h.conversation.handle(receive('bayar bensin'));

    expect(h.asked).toEqual([]);
    expect(h.pending()?.kind).toBe('amount');
  });
});

describe('jawaban bebas: hanya untuk pesan yang tidak bisa diproses deterministik', () => {
  const FREEFORM = 'Halo! Saya asisten Cashify. Silakan tulis transaksi dalam satu pesan.';

  it('UNKNOWN dijawab bebas setelah klasifikasi tidak menemukan aksi', async () => {
    const h = harness(async () => null, async () => FREEFORM);
    await h.conversation.handle(receive('halo apa kabar'));

    expect(h.replies).toEqual([FREEFORM]);
    expect(h.asked).toEqual(['halo apa kabar']);
    expect(h.answered).toEqual(['halo apa kabar']);
  });

  it('QUERY yang dikenali regex langsung dijawab bebas, tanpa klasifikasi', async () => {
    const h = harness(async () => null, async () => FREEFORM);
    await h.conversation.handle(receive('saldo'));

    expect(h.replies).toEqual([FREEFORM]);
    expect(h.asked).toEqual([]);
    expect(h.answered).toEqual(['saldo']);
  });

  it('CORRECT yang dikenali regex dijawab bebas', async () => {
    const h = harness(async () => null, async () => FREEFORM);
    await h.conversation.handle(receive('ubah jadi 35 ribu'));

    expect(h.replies).toEqual([FREEFORM]);
    expect(h.answered).toEqual(['ubah jadi 35 ribu']);
  });

  it('jawaban null atau galat port jatuh ke template', async () => {
    const empty = harness(async () => null, async () => null);
    await empty.conversation.handle(receive('halo apa kabar'));
    expect(empty.replies[0]).toContain(NOT_UNDERSTOOD);

    const broken = harness(async () => null, async () => {
      throw new Error('port rusak');
    });
    await broken.conversation.handle(receive('saldo'));
    expect(broken.replies[0]).toContain('belum tersedia lewat WhatsApp');
  });

  it('saat ada pending, obrolan tetap dijawab state machine, bukan LLM', async () => {
    const h = harness(async () => null, async () => FREEFORM);

    await h.conversation.handle(receive('bayar bensin'));
    expect(h.pending()?.kind).toBe('amount');

    await h.conversation.handle(receive('halo apa kabar'));
    expect(h.pending()?.kind).toBe('amount');
    expect(h.replies[1]).toContain('Nominalnya');

    await h.conversation.handle(receive('saldo'));
    expect(h.replies[2]).toContain('belum tersedia lewat WhatsApp');
    expect(h.answered).toEqual([]);
  });

  it('pesan transaksi, konfirmasi, dan command tidak pernah memakai jawaban bebas', async () => {
    const h = harness(async () => hint({ categoryHint: 'makanan' }), async () => FREEFORM);

    await h.conversation.handle(receive('jajan di warteg 25rb'));
    expect(h.replies[0]).toContain('Rp25.000');
    expect(h.replies[0]).toContain('YA untuk simpan');

    await h.conversation.handle(receive('ya'));
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.amount).toBe(25_000);

    await h.conversation.handle(receive('/entah'));
    expect(h.replies[2]).toContain(NOT_UNDERSTOOD);

    expect(h.answered).toEqual([]);
  });
});
