// Alur percakapan WhatsApp (ARCHITECTURE.md Bagian 6): satu pesan teks dari pengguna yang sudah
// dikenali masuk, paling banyak satu balasan keluar. Tidak tahu BullMQ, Redis, Prisma, maupun
// OpenWA: semuanya masuk lewat `ConversationPorts`, `PendingPort`, dan `reply`, jadi modul ini bisa
// diuji sendirian dan tidak mengimpor modul lain.
//
// State percakapan hanya satu: `pending:{user_id}` di Redis (TTL 15 menit, lib/pendingState.ts).
// Bentuknya:
//   confirmation -> transaksi lengkap, menunggu "ya" / "batal"
//   category     -> nominal ada, kategori kabur; pengguna memilih nomor atau menyebut nama
//   amount       -> nominal tidak ada (atau ambigu); pengguna menyebut nominal
//   delete       -> transaksi terakhir yang akan dihapus, menunggu "ya" / "batal"
// Pending baru menimpa yang lama tanpa pemberitahuan. Tidak ada pengingat saat kedaluwarsa.
//
// Nominal dan tanggal SELALU dari parser (regex). LLM tidak terlibat sama sekali (aturan 2), dan
// semua teks balasan dari whatsapp.templates.ts (aturan 3).

import { z } from 'zod';
import { classifyCategory, extractAmount, normalize, parseMessage } from '../../parsers/index.js';
import type { CategoryDictionary, ParseResult, RejectReason, TransactionType } from '../../parsers/types.js';
import { addDays, toJakartaDate } from '../../shared/utils/timezone.js';
import * as reply from './whatsapp.templates.js';
import type {
  ConversationCategory,
  ConversationOutcome,
  ConversationPorts,
  ConversationTransaction,
  IncomingText,
  ReplyRequest,
} from './whatsapp.types.js';

/** Berapa kategori yang ditawarkan saat kategori kabur. */
export const CATEGORY_OPTION_COUNT = 3;
/** Kategori "paling sering dipakai" dihitung dari transaksi sejauh ini. */
const POPULAR_WINDOW_DAYS = 90;

// ---------------------------------------------------------------------------
// Isi pending
// ---------------------------------------------------------------------------

const draftBase = z.object({
  type: z.enum(['income', 'expense']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().max(255),
  /** Angka telanjang yang dibaca ribuan; tampil di konfirmasi. */
  assumedThousands: z.boolean(),
  /** `message_logs.id` pesan tempat nominal ditulis; menjadi `source_message_id` transaksi. */
  sourceMessageId: z.uuid(),
});
const amountField = z.number().int().positive();

/** Hanya angka, slug, dan id: teks balasan tidak pernah disimpan di Redis. */
export const pendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('confirmation'), draft: draftBase.extend({ amount: amountField, categorySlug: z.string() }) }),
  z.object({
    kind: z.literal('category'),
    draft: draftBase.extend({ amount: amountField }),
    /** Slug yang ditawarkan, urut sesuai nomornya. */
    options: z.array(z.string()).min(1).max(CATEGORY_OPTION_COUNT),
  }),
  z.object({ kind: z.literal('amount'), draft: draftBase.extend({ categorySlug: z.string().optional() }) }),
  z.object({ kind: z.literal('delete'), transactionId: z.uuid() }),
]);

export type Pending = z.infer<typeof pendingSchema>;
type Draft = Extract<Pending, { kind: 'amount' }>['draft'];

export interface PendingPort {
  get(userId: string): Promise<Pending | null>;
  set(userId: string, value: Pending): Promise<void>;
  clear(userId: string): Promise<void>;
}

export interface ConversationDeps extends ConversationPorts {
  pending: PendingPort;
  /** Memasukkan balasan ke antrean `outbound`. Bukan memanggil gateway (aturan 10). */
  reply: (request: ReplyRequest) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Pembantu
// ---------------------------------------------------------------------------

const AWAITING = { confirmation: 'confirmation', delete: 'confirmation', category: 'category', amount: 'amount' } as const;

const CATEGORY_NUMBER = /^\d{1,2}$/;

const toDictionary = (categories: readonly ConversationCategory[]): CategoryDictionary =>
  categories.map(({ slug, name, type, keywords }) => ({ slug, name, type, keywords }));

function findCategory(
  categories: readonly ConversationCategory[],
  slug: string,
  type: TransactionType,
): ConversationCategory | undefined {
  return categories.find((category) => category.slug === slug && category.type === type);
}

/** Kategori cadangan ("Lainnya") tidak ikut nomor; pengguna tetap bisa mengetik "lainnya". */
const isFallback = (category: ConversationCategory): boolean => category.slug.startsWith('other_');

function toView(
  draft: { type: TransactionType; date: string; description: string; assumedThousands: boolean },
  amount: number,
  category: ConversationCategory,
): reply.TransactionView {
  return {
    type: draft.type,
    amount,
    categoryName: category.name,
    categorySlug: category.slug,
    date: draft.date,
    description: draft.description,
    assumedThousands: draft.assumedThousands,
  };
}

function savedView(record: ConversationTransaction, categorySlug: string, assumedThousands = false): reply.TransactionView {
  return {
    type: record.type,
    amount: record.amount,
    categoryName: record.category.name,
    categorySlug,
    date: record.date,
    description: record.description ?? '',
    assumedThousands,
  };
}

// ---------------------------------------------------------------------------
// Percakapan
// ---------------------------------------------------------------------------

export function createConversation(deps: ConversationDeps) {
  const { pending: store, transactions } = deps;

  /** Tiga kategori yang ditawarkan: yang paling sering dipakai pengguna, dilengkapi urutan bawaan. */
  async function pickOptions(
    userId: string,
    type: TransactionType,
    categories: readonly ConversationCategory[],
    today: string,
  ): Promise<ConversationCategory[]> {
    const ofType = categories.filter((category) => category.type === type && !isFallback(category));
    const popularIds = await transactions.topCategoryIds(
      userId,
      type,
      addDays(today, -POPULAR_WINDOW_DAYS),
      CATEGORY_OPTION_COUNT,
    );
    const popular = popularIds
      .map((id) => ofType.find((category) => category.id === id))
      .filter((category): category is ConversationCategory => category !== undefined);
    const rest = ofType.filter((category) => !popular.includes(category));
    return [...popular, ...rest].slice(0, CATEGORY_OPTION_COUNT);
  }

  /** Mengirim satu balasan dan mengembalikan hasil yang dicatat ke `message_logs`. */
  function done(msg: IncomingText, text: string | null, intent: string, parseResult: Record<string, unknown>): Promise<ConversationOutcome> {
    const outcome: ConversationOutcome = { intent, parseResult };
    if (text === null) return Promise.resolve(outcome);
    return deps.reply({ to: msg.replyTo, text, messageLogId: msg.messageId }).then(() => outcome);
  }

  /** Menyimpan pending `category` dan menanyakan kategorinya. */
  async function askCategory(
    msg: IncomingText,
    categories: readonly ConversationCategory[],
    draft: Draft & { amount: number },
    today: string,
  ): Promise<string> {
    const options = await pickOptions(msg.userId, draft.type, categories, today);
    if (options.length === 0) {
      // Tidak ada kategori sama sekali untuk tipe ini (data rusak): jangan menggantung pengguna.
      await store.clear(msg.userId);
      return reply.categoryGone();
    }
    // Store membuang field yang tidak ada di skema (categorySlug), jadi draft boleh diteruskan apa adanya.
    await store.set(msg.userId, { kind: 'category', draft, options: options.map((option) => option.slug) });
    return reply.askCategory({ options: options.map((option) => option.name), amount: draft.amount });
  }

  /** Nominal dan kategori lengkap: simpan pending `confirmation` dan minta konfirmasi. */
  async function askConfirmation(
    msg: IncomingText,
    draft: Draft,
    amount: number,
    category: ConversationCategory,
    today: string,
  ): Promise<string> {
    await store.set(msg.userId, { kind: 'confirmation', draft: { ...draft, amount, categorySlug: category.slug } });
    return reply.confirmation(toView(draft, amount, category), today);
  }

  async function handleParsed(
    msg: IncomingText,
    result: Exclude<ParseResult, { outcome: 'ignored' }>,
    categories: readonly ConversationCategory[],
    today: string,
  ): Promise<string> {
    switch (result.outcome) {
      case 'rejected':
        // Pending lama tidak disentuh: pesan yang ditolak tidak menggantikan apa pun.
        return reply.rejection(result.reason);

      case 'ready': {
        const draft: Draft = {
          type: result.type,
          date: result.date,
          description: result.description,
          assumedThousands: result.assumptions.includes('amount_in_thousands'),
          sourceMessageId: msg.messageId,
          categorySlug: result.categorySlug,
        };
        const category = findCategory(categories, result.categorySlug, result.type);
        if (!category) return askCategory(msg, categories, { ...draft, amount: result.amount }, today);
        return askConfirmation(msg, draft, result.amount, category, today);
      }

      case 'clarify': {
        const draft: Draft = {
          type: result.type,
          date: result.date,
          description: result.description,
          assumedThousands: result.assumptions.includes('amount_in_thousands'),
          sourceMessageId: msg.messageId,
          ...(result.categorySlug !== undefined && { categorySlug: result.categorySlug }),
        };
        if (result.ask === 'category' && result.amount !== undefined) {
          return askCategory(msg, categories, { ...draft, amount: result.amount }, today);
        }
        await store.set(msg.userId, { kind: 'amount', draft });
        if (result.ambiguousAmount !== undefined) return reply.askAmountAmbiguous(result.ambiguousAmount);
        const category = result.categorySlug ? findCategory(categories, result.categorySlug, result.type) : undefined;
        return reply.askAmount({ description: result.description, categoryName: category?.name });
      }

      case 'intent':
        return handleIntent(msg, result, categories, today);
    }
  }

  async function handleIntent(
    msg: IncomingText,
    result: Extract<ParseResult, { outcome: 'intent' }>,
    categories: readonly ConversationCategory[],
    today: string,
  ): Promise<string> {
    const current = await store.get(msg.userId);

    switch (result.intent) {
      case 'CONFIRM':
        return confirm(msg, current, categories, today);

      case 'CANCEL':
        if (!current) return reply.nothingToCancel();
        await store.clear(msg.userId);
        return reply.cancelled();

      case 'CLARIFY_RESPONSE':
        return clarify(msg, current, categories, today);

      case 'DELETE': {
        const latest = await transactions.latestFromWhatsapp(msg.userId, msg.sentAt);
        if (!latest) return reply.nothingToDelete();
        await store.set(msg.userId, { kind: 'delete', transactionId: latest.id });
        return reply.confirmDelete(savedView(latest, slugOf(categories, latest)), today);
      }

      case 'HELP':
        return reply.help();
      case 'QUERY':
        return reply.queryUnavailable();
      case 'CORRECT':
        return reply.correctUnavailable();
      case 'UNKNOWN':
        // Sedang di tengah percakapan: ingatkan pertanyaannya, jangan jatuh ke panduan umum.
        if (current?.kind === 'amount') return reply.askAmountAgain();
        if (current?.kind === 'category') {
          return reply.askCategoryAgain({ options: optionNames(categories, current) }, reply.CATEGORY_NOT_FOUND);
        }
        if (current) return reply.confirmationStillWaiting();
        return reply.unknownMessage();
    }
  }

  /** Slug kategori sebuah transaksi tersimpan (hanya untuk emoji); kosong bila kategorinya sudah tidak terdaftar. */
  function slugOf(categories: readonly ConversationCategory[], record: ConversationTransaction): string {
    return categories.find((category) => category.id === record.category.id)?.slug ?? '';
  }

  async function confirm(
    msg: IncomingText,
    current: Pending | null,
    categories: readonly ConversationCategory[],
    today: string,
  ): Promise<string> {
    if (!current) return reply.nothingToConfirm();

    if (current.kind === 'delete') {
      // Yang dihapus adalah yang ditawarkan di pending, bukan "yang terakhir sekarang".
      const removed = await transactions.remove(msg.userId, current.transactionId);
      await store.clear(msg.userId);
      return removed ? reply.deleted(savedView(removed, slugOf(categories, removed))) : reply.alreadyDeleted();
    }

    if (current.kind === 'category') {
      const names = optionNames(categories, current);
      return reply.askCategoryAgain({ options: names }, reply.CATEGORY_FIRST);
    }
    if (current.kind === 'amount') return reply.askAmountAgain();

    // confirmation
    const { draft } = current;
    const category = findCategory(categories, draft.categorySlug, draft.type);
    if (!category) {
      await store.clear(msg.userId);
      return reply.categoryGone();
    }

    // Job "ya" yang diulang setelah transaksi tersimpan tetapi sebelum pending terhapus tidak boleh menggandakan.
    let record = await transactions.findBySourceMessage(msg.userId, draft.sourceMessageId);
    if (!record) {
      const accountId = await deps.accounts.defaultAccountId(msg.userId);
      if (!accountId) {
        await store.clear(msg.userId);
        return reply.noAccount();
      }
      record = await transactions.createFromWhatsapp(msg.userId, {
        type: draft.type,
        amount: draft.amount,
        categoryId: category.id,
        accountId,
        date: draft.date,
        description: draft.description === '' ? null : draft.description,
        messageTime: msg.sentAt,
        sourceMessageId: draft.sourceMessageId,
      });
    }
    await store.clear(msg.userId);
    return reply.saved(savedView(record, category.slug), today);
  }

  function optionNames(categories: readonly ConversationCategory[], current: Extract<Pending, { kind: 'category' }>): string[] {
    return current.options
      .map((slug) => findCategory(categories, slug, current.draft.type)?.name)
      .filter((name): name is string => name !== undefined);
  }

  /** Jawaban atas pertanyaan kategori atau nominal. */
  async function clarify(
    msg: IncomingText,
    current: Pending | null,
    categories: readonly ConversationCategory[],
    today: string,
  ): Promise<string> {
    const text = normalize(msg.text).text.replace(/[.!?,\s]+$/, '');

    if (current?.kind === 'category') {
      const type = current.draft.type;
      const dictionary = toDictionary(categories.filter((category) => category.type === type));
      const names = optionNames(categories, current);

      let slug: string | undefined;
      if (CATEGORY_NUMBER.test(text)) {
        slug = current.options[Number(text) - 1];
      } else {
        const matched = classifyCategory(text, dictionary);
        if (matched.status === 'matched') slug = matched.slug;
      }
      const category = slug ? findCategory(categories, slug, type) : undefined;
      if (!category) return reply.askCategoryAgain({ options: names }, reply.CATEGORY_NOT_FOUND);

      return askConfirmation(msg, current.draft, current.draft.amount, category, today);
    }

    if (current?.kind === 'amount') {
      const found = extractAmount(text, current.draft.type);
      switch (found.status) {
        case 'missing':
          return reply.askAmountAgain();
        case 'ambiguous':
          return reply.askAmountAmbiguous(found.value);
        case 'rejected':
          return reply.rejection(`amount_${found.reason}` as RejectReason);
        case 'found': {
          const draft: Draft = {
            ...current.draft,
            assumedThousands: current.draft.assumedThousands || found.assumedThousands,
          };
          const category = draft.categorySlug ? findCategory(categories, draft.categorySlug, draft.type) : undefined;
          if (!category) return askCategory(msg, categories, { ...draft, amount: found.amount }, today);
          return askConfirmation(msg, draft, found.amount, category, today);
        }
      }
    }

    return reply.unknownMessage();
  }

  return {
    /** Memproses satu pesan teks: parse, cabang menurut intent, satu balasan (atau tidak sama sekali). */
    async handle(msg: IncomingText): Promise<ConversationOutcome> {
      const today = toJakartaDate(msg.sentAt);
      const [current, categories] = await Promise.all([store.get(msg.userId), deps.categories.list(msg.userId)]);

      const result = parseMessage(msg.text, {
        now: msg.sentAt,
        categories: toDictionary(categories),
        ...(current && { awaiting: AWAITING[current.kind] }),
      });
      const parseResult = result as unknown as Record<string, unknown>;

      if (result.outcome === 'ignored') return done(msg, null, 'IGNORED', parseResult);

      const text = await handleParsed(msg, result, categories, today);
      return done(msg, text, result.intent, parseResult);
    },
  };
}

export type Conversation = ReturnType<typeof createConversation>;
