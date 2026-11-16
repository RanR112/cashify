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
// Nominal dan tanggal SELALU dari parser (regex); LLM tidak pernah menyentuhnya (aturan 2). LLM
// hanya menjadi cadangan klasifikasi kategori dan intent ketika kamus kata kunci gagal memutuskan
// (ARCHITECTURE.md Bagian 7 tahap 5), lewat port `llm` yang dirakit di src/workers/pipeline.ts.
// Tanpa port itu (proses API, test lama) perilakunya persis seperti sebelumnya. Semua teks balasan
// tetap dari whatsapp.templates.ts (aturan 3), tidak pernah dari teks LLM — kecuali pengecualian
// opt-in di bawah.
//
// Pengecualian opt-in: `LLM_REPLY_MODE=freeform` merakit `llm.answer`, dan jawaban bebas itu
// dikirim HANYA untuk pesan yang tidak bisa diproses deterministik (UNKNOWN, QUERY, CORRECT tanpa
// pending). Jalur transaksi, konfirmasi, hapus, command, dan media tidak pernah memakainya.

import { z } from 'zod';
import { classifyCategory, extractAmount, normalize, parseMessage } from '../../parsers/index.js';
import type { CategoryDictionary, Intent, ParseResult, RejectReason, TransactionType } from '../../parsers/types.js';
import { addDays, toJakartaDate } from '../../shared/utils/timezone.js';
import * as reply from './whatsapp.templates.js';
import type {
  ConversationCategory,
  ConversationLlm,
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
type EditablePending = Extract<Pending, { kind: 'amount' }> | Extract<Pending, { kind: 'confirmation' }>;

export interface PendingPort {
  get(userId: string): Promise<Pending | null>;
  set(userId: string, value: Pending): Promise<void>;
  clear(userId: string): Promise<void>;
}

export interface ConversationDeps extends ConversationPorts {
  pending: PendingPort;
  /** Memasukkan balasan ke antrean `outbound`. Bukan memanggil gateway (aturan 10). */
  reply: (request: ReplyRequest) => Promise<unknown>;
  /** Cadangan LLM; tidak ada di proses API dan di test lama (perilaku tetap deterministik). */
  llm?: ConversationLlm;
}

// ---------------------------------------------------------------------------
// Pembantu
// ---------------------------------------------------------------------------

const AWAITING = { confirmation: 'confirmation', delete: 'confirmation', category: 'category', amount: 'amount' } as const;

const CATEGORY_NUMBER = /^\d{1,2}$/;

/**
 * Awalan eksplisit untuk mengubah catatan pending. Hanya berlaku saat pending nominal/konfirmasi
 * dan pesan tidak memuat nominal; tanpa awalan ini, pesan tetap diperlakukan seperti biasa supaya
 * transaksi baru tidak berubah menjadi edit.
 */
const DESCRIPTION_EDIT = /^(?:tolong\s+|mohon\s+)?catat(?:in|kan|lah)?\b/i;

/**
 * Intent yang boleh datang dari LLM sebagai cadangan. `UNKNOWN` tidak ikut supaya jawaban "tidak
 * tahu" tidak memicu panggilan kedua, dan `CREATE_TRANSACTION` tidak ikut karena tanpa nominal
 * (yang selalu dari regex) tidak ada yang bisa dikerjakan.
 */
const LLM_INTENTS: ReadonlySet<Exclude<Intent, 'CREATE_TRANSACTION'>> = new Set([
  'CONFIRM',
  'CANCEL',
  'QUERY',
  'CORRECT',
  'DELETE',
  'HELP',
]);

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
  const llm = deps.llm;

  /**
   * Cadangan kategori dari LLM, dipakai HANYA ketika kamus kata kunci gagal (Bagian 7 tahap 5).
   * `category_hint` dicocokkan ke kategori milik pengguna yang tipenya sama; hint yang tidak
   * dikenal diabaikan, tidak pernah menciptakan kategori baru.
   */
  async function hintCategory(
    text: string,
    categories: readonly ConversationCategory[],
    type: TransactionType,
  ): Promise<ConversationCategory | undefined> {
    if (!llm) return undefined;
    const hint = await llm.hint(text);
    const wanted = hint?.categoryHint.trim().toLowerCase() ?? '';
    if (wanted === '') return undefined;
    const pool = categories.filter((category) => category.type === type);
    const matched = classifyCategory(wanted, toDictionary(pool));
    const slug = matched.status === 'matched' ? matched.slug : pool.find((category) => category.name.toLowerCase() === wanted)?.slug;
    return slug === undefined ? undefined : pool.find((category) => category.slug === slug);
  }

  /** Cadangan intent dari LLM, dipakai HANYA ketika regex tidak memutuskan (parseMessage -> UNKNOWN). */
  async function hintIntent(text: string): Promise<Exclude<Intent, 'CREATE_TRANSACTION'> | undefined> {
    if (!llm) return undefined;
    const hint = await llm.hint(text);
    const intent = hint?.intent as Exclude<Intent, 'CREATE_TRANSACTION'> | undefined;
    return intent !== undefined && LLM_INTENTS.has(intent) ? intent : undefined;
  }

  /**
   * Jawaban bebas dari LLM (hanya `LLM_REPLY_MODE=freeform`). `null` berarti tidak ada jawaban
   * layak; pemanggil memakai template. Tidak pernah dipakai pada jalur transaksi atau konfirmasi,
   * dan teksnya tidak pernah diparse.
   */
  async function freeform(text: string): Promise<string | null> {
    if (!llm?.answer) return null;
    try {
      return await llm.answer(text);
    } catch {
      // Port seharusnya tidak melempar (safeChat menangkap semua), tetapi percakapan tidak boleh
      // gagal hanya karena implementasi port keliru.
      return null;
    }
  }

  /** Mengubah catatan pending tanpa menyentuh nominal, kategori, tanggal, atau sumber pesan. */
  async function editPendingDescription(
    msg: IncomingText,
    current: EditablePending,
    description: string,
    categories: readonly ConversationCategory[],
    today: string,
  ): Promise<string> {
    if (current.kind === 'amount') {
      const draft: Draft = { ...current.draft, description };
      await store.set(msg.userId, { kind: 'amount', draft });
      const category = draft.categorySlug ? findCategory(categories, draft.categorySlug, draft.type) : undefined;
      return reply.askAmount({ description, categoryName: category?.name });
    }

    const draft = { ...current.draft, description };
    const category = findCategory(categories, draft.categorySlug, draft.type);
    if (!category) return askCategory(msg, categories, draft, today);
    await store.set(msg.userId, { kind: 'confirmation', draft });
    return reply.confirmation(toView(draft, draft.amount, category), today);
  }

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
          // Kamus tidak mengenali kategorinya: LLM boleh menyebut kategori, tetapi hanya yang
          // benar-benar ada. Gagal berarti bertanya seperti biasa.
          const hinted = await hintCategory(msg.text, categories, result.type);
          if (hinted) return askConfirmation(msg, draft, result.amount, hinted, today);
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
      case 'QUERY': {
        // Mode freeform boleh menjawab bebas, tetapi tidak saat ada transaksi yang menunggu
        // konfirmasi: jawaban obrolan akan mengaburkan pertanyaan YA/BATAL.
        const answerText = current ? null : await freeform(msg.text);
        return answerText ?? reply.queryUnavailable();
      }
      case 'CORRECT': {
        const answerText = current ? null : await freeform(msg.text);
        return answerText ?? reply.correctUnavailable();
      }
      case 'UNKNOWN':
        // Sedang di tengah percakapan: ingatkan pertanyaannya, jangan jatuh ke panduan umum.
        if (current?.kind === 'amount') return reply.askAmountAgain();
        if (current?.kind === 'category') {
          return reply.askCategoryAgain({ options: optionNames(categories, current) }, reply.CATEGORY_NOT_FOUND);
        }
        if (current) return reply.confirmationStillWaiting();
        // Command tak dikenal ("/foo") bukan bahasa alami: tetap tidak ditebak.
        if (msg.text.trimStart().startsWith('/')) return reply.unknownMessage();
        const hinted = await hintIntent(msg.text);
        if (hinted) return handleIntent(msg, { outcome: 'intent', intent: hinted, original: result.original }, categories, today);
        // Klasifikasi tidak menemukan aksi yang bisa dijalankan: mode freeform boleh menjawab
        // bebas; gagal berarti panduan singkat seperti sebelumnya.
        const answerText = await freeform(msg.text);
        return answerText ?? reply.unknownMessage();
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
      // Jawaban yang tetap tidak dikenali kamus dicoba ke LLM; gagal berarti tanya lagi.
      const category =
        (slug ? findCategory(categories, slug, type) : undefined) ?? (await hintCategory(msg.text, categories, type));
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

      // "catat ... aja" saat pending nominal/konfirmasi adalah ralat catatan, bukan transaksi baru.
      // Nominal tetap wajib lewat regex; di sini pesan justru tidak boleh memuat nominal.
      if (
        current !== null &&
        (current.kind === 'amount' || current.kind === 'confirmation') &&
        result.outcome === 'clarify' &&
        result.ask === 'amount' &&
        result.ambiguousAmount === undefined &&
        DESCRIPTION_EDIT.test(normalize(msg.text).text)
      ) {
        const text =
          result.description === ''
            ? current.kind === 'amount'
              ? reply.askAmountAgain()
              : reply.confirmationStillWaiting()
            : await editPendingDescription(msg, current, result.description, categories, today);
        return done(msg, text, result.intent, parseResult);
      }

      const text = await handleParsed(msg, result, categories, today);
      return done(msg, text, result.intent, parseResult);
    },
  };
}

export type Conversation = ReturnType<typeof createConversation>;
