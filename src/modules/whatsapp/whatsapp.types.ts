import type { z } from 'zod';
import type {
  linkPendingSchema,
  linkVerifiedSchema,
  preferencesSchema,
  whatsappStatusSchema,
} from './whatsapp.schema.js';

export type WhatsappStatus = z.infer<typeof whatsappStatusSchema>;
export type LinkPending = z.infer<typeof linkPendingSchema>;
export type LinkVerified = z.infer<typeof linkVerifiedSchema>;
export type WhatsappPreferences = z.infer<typeof preferencesSchema>;

/** Pesan keluar untuk antrean `outbound`; bentuknya subset dari `OutboundJobData` (modul tidak mengimpor `queues/`). */
export interface OutboundMessage {
  wa_chat_id: string;
  text: string;
}

/** Nilai kolom `whatsapp_accounts.status`. */
export type AccountStatus = 'pending' | 'verified' | 'disabled';

export interface WhatsappAccountRecord {
  id: string;
  userId: string;
  phoneE164: string;
  waChatId: string;
  status: AccountStatus;
  verifiedAt: Date | null;
  lastMessageAt: Date | null;
  dailySummaryEnabled: boolean;
  budgetAlertEnabled: boolean;
}

export interface VerificationRecord {
  id: string;
  userId: string;
  phoneE164: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface NewVerification {
  phoneE164: string;
  codeHash: string;
  expiresAt: Date;
}

/** Hasil `completeVerification`: `already_used` bila kode sudah dipakai (balapan atau pemakaian ulang). */
export type CompleteResult =
  | { outcome: 'verified'; account: WhatsappAccountRecord }
  | { outcome: 'already_used' }
  | { outcome: 'phone_taken' };

export interface SessionSnapshot {
  sessionId: string;
  connected: boolean;
  detail?: string | undefined;
}

/** Pesan masuk dari `message_logs`, dengan isi `raw_payload` yang dipakai worker sudah dibaca. */
export interface InboundMessageRecord {
  id: string;
  sessionId: string;
  /** Di OpenWA v4 untuk chat pribadi berupa LID (`...@lid`), bukan nomor. */
  waChatId: string;
  /** `raw_payload.data.sender.phoneNumber` (`...@c.us`); null bila tidak ada. Dasar pencocokan pengguna dan tujuan balasan. */
  senderChatId: string | null;
  messageType: string;
  body: string | null;
  status: string;
  createdAt: Date;
  /** `raw_payload.data.timestamp` (waktu pesan menurut WhatsApp); bila tidak ada, `createdAt`. */
  sentAt: Date;
}

/** Hasil akhir pemrosesan sebuah pesan; ditulis ke `message_logs`. */
export interface MessageOutcome {
  status: 'processed' | 'ignored' | 'failed';
  userId?: string | undefined;
  intent?: string | undefined;
  parseResult?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

/** Semua metode yang menyangkut pengguna menerima `userId` (dari klaim JWT) sebagai argumen pertama. */
export interface WhatsappRepository {
  /** Tautan `pending` atau `verified` milik pengguna; `disabled` tidak dihitung. */
  findActiveAccount(userId: string): Promise<WhatsappAccountRecord | null>;
  /** Nomor ini sudah terverifikasi di akun mana pun (termasuk pengguna lain). */
  isPhoneVerifiedByAnyone(phoneE164: string): Promise<boolean>;
  /**
   * Membuat baris `pending` atau mengganti nomor pada baris `pending` yang ada. Verifikasi lama
   * milik pengguna yang belum terpakai ditandai terpakai agar kodenya tidak bisa dipakai lagi.
   */
  upsertPendingAccount(userId: string, phoneE164: string, waChatId: string, now: Date): Promise<WhatsappAccountRecord>;
  createVerification(userId: string, input: NewVerification): Promise<VerificationRecord>;
  /** Verifikasi terbaru yang belum terpakai (kedaluwarsa tidak disaring; itu urusan service). */
  findPendingVerification(userId: string): Promise<VerificationRecord | null>;
  /** Verifikasi terbaru apa pun statusnya, untuk jeda minimal resend. */
  findLatestVerification(userId: string): Promise<VerificationRecord | null>;
  /** Jumlah dan waktu terlama OTP yang dibuat sejak `since`, per nomor (semua pengguna) atau per pengguna. */
  countVerificationsSince(
    scope: { phoneE164: string } | { userId: string },
    since: Date,
  ): Promise<{ count: number; oldest: Date | null }>;
  /** Menambah `attempts` secara atomik hanya bila masih di bawah `max`. Mengembalikan nilai barunya, atau null bila sudah habis/terpakai. */
  incrementAttempts(userId: string, verificationId: string, max: number): Promise<number | null>;
  completeVerification(userId: string, verificationId: string, now: Date): Promise<CompleteResult>;
  /** Soft: status menjadi `disabled`. False bila tidak ada tautan aktif (`pending` atau `verified`). */
  disableAccount(userId: string): Promise<boolean>;
  /** Null bila tidak ada tautan `verified`. */
  updatePreferences(userId: string, patch: Partial<WhatsappPreferences>): Promise<WhatsappAccountRecord | null>;

  /** Baris sesi bot milik sistem, bukan milik pengguna. */
  upsertSession(snapshot: SessionSnapshot, now: Date): Promise<void>;

  // ---- Pemrosesan pesan masuk (worker inbound) ----
  // `message_logs` bukan data milik pengguna sampai pengirimnya dikenali: pesan nomor asing
  // disimpan tanpa `user_id`, jadi metode di bawah memakai id pesan, bukan `userId`.

  /** Tautan `verified` yang `wa_chat_id`-nya salah satu dari `chatIds` (LID dan nomor tidak dicampur: pemanggil memberi keduanya). */
  findVerifiedAccountByChat(chatIds: string[]): Promise<WhatsappAccountRecord | null>;
  findInboundMessage(id: string): Promise<InboundMessageRecord | null>;
  /**
   * Pesan inbound `received` di chat ini yang dibuat sejak `since`, selain `excludeId`, terlama
   * dulu menurut `created_at`. Pengurutan menurut `sentAt` dilakukan pemanggil.
   */
  findReceivedInChat(sessionId: string, waChatId: string, since: Date, excludeId: string, limit: number): Promise<InboundMessageRecord[]>;
  /**
   * Menutup pesan yang masih `received`. False bila sudah ditutup (pemrosesan ganda atau job
   * diulang), dan pemanggil harus berhenti tanpa efek samping.
   */
  closeMessage(id: string, outcome: MessageOutcome, now: Date): Promise<boolean>;
  /** Mencatat balasan yang gagal terkirim permanen pada pesan pemicunya; status pesan tidak berubah. */
  recordReplyFailure(messageId: string): Promise<void>;
  touchLastMessage(userId: string, at: Date): Promise<void>;
}

// ---------------------------------------------------------------------------
// Alur percakapan (whatsapp.conversation.ts)
// ---------------------------------------------------------------------------
// Bentuk di bawah sengaja berdiri sendiri, bukan diimpor dari modul transactions/categories/accounts
// (modul tidak mengimpor modul lain). Service aslinya memenuhinya secara struktural dan dirakit di
// src/worker.ts.

/** Satu baris kamus kategori: yang dibutuhkan parser ditambah id untuk menyimpan transaksi. */
export interface ConversationCategory {
  id: string;
  slug: string;
  name: string;
  type: 'income' | 'expense';
  keywords: readonly string[];
}

/** Transaksi yang sudah tersimpan, sebatas yang dibutuhkan balasan. */
export interface ConversationTransaction {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  /** YYYY-MM-DD, Jakarta. */
  date: string;
  description: string | null;
  category: { id: string; name: string };
}

export interface NewWhatsappTransaction {
  type: 'income' | 'expense';
  amount: number;
  categoryId: string;
  accountId: string;
  date: string;
  description: string | null;
  messageTime: Date;
  sourceMessageId: string;
}

export interface ConversationPorts {
  categories: { list(userId: string): Promise<ConversationCategory[]> };
  accounts: { defaultAccountId(userId: string): Promise<string | null> };
  transactions: {
    createFromWhatsapp(userId: string, input: NewWhatsappTransaction): Promise<ConversationTransaction>;
    findBySourceMessage(userId: string, sourceMessageId: string): Promise<ConversationTransaction | null>;
    latestFromWhatsapp(userId: string, now: Date): Promise<ConversationTransaction | null>;
    topCategoryIds(userId: string, type: 'income' | 'expense', sinceDate: string, limit: number): Promise<string[]>;
    /** Soft delete. Mengembalikan transaksi yang dihapus, atau null bila sudah tidak ada. */
    remove(userId: string, transactionId: string): Promise<ConversationTransaction | null>;
  };
}

/** Satu balasan untuk satu pesan masuk. `messageLogId` jadi kunci dedupe dan dasar pencatatan gagal kirim. */
export interface ReplyRequest {
  to: string;
  text: string;
  messageLogId: string;
}

export interface IncomingText {
  userId: string;
  /** `message_logs.id` pesan ini. */
  messageId: string;
  text: string;
  /** Waktu pesan menurut WhatsApp; menjadi `now` parser dan jam transaksi. */
  sentAt: Date;
  /** Tujuan balasan (`...@c.us`). */
  replyTo: string;
}

/** Yang dicatat ke `message_logs` setelah pesan diproses. */
export interface ConversationOutcome {
  intent: string;
  parseResult: Record<string, unknown>;
}
