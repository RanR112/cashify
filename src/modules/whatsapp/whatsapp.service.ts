import type { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.js';
import { maskPhone, toWaChatId } from '../../shared/utils/phone.js';
import {
  buildOtpMessage,
  defaultOtp,
  OTP_MAX_ATTEMPTS,
  OTP_PER_PHONE_PER_DAY,
  OTP_PER_USER_PER_DAY,
  OTP_RESEND_GAP_MS,
  OTP_TTL_MS,
  OTP_WINDOW_MS,
  type OtpToolkit,
} from './whatsapp.otp.js';
import type { SessionMonitor } from './whatsapp.session.js';
import type { linkRequestBodySchema, linkVerifyBodySchema, preferencesBodySchema } from './whatsapp.schema.js';
import type {
  LinkPending,
  LinkVerified,
  OutboundMessage,
  WhatsappAccountRecord,
  WhatsappRepository,
  WhatsappStatus,
} from './whatsapp.types.js';

type LinkRequestInput = z.infer<typeof linkRequestBodySchema>;
type LinkVerifyInput = z.infer<typeof linkVerifyBodySchema>;
type PreferencesInput = z.infer<typeof preferencesBodySchema>;

export interface WhatsappServiceDeps {
  repository: WhatsappRepository;
  session: SessionMonitor;
  /**
   * Memasukkan pesan ke antrean `outbound`. Service tidak pernah memanggil gateway untuk mengirim:
   * pengiriman lewat worker agar tunduk pada concurrency 1 dan jeda acak (aturan 12).
   */
  enqueueOutbound: (message: OutboundMessage) => Promise<unknown>;
  otp?: OtpToolkit;
  /** Penyuntik jam untuk test. */
  now?: () => Date;
}

const NO_PENDING_MESSAGE = 'Tidak ada permintaan penautan yang menunggu';

const DEFAULT_PREFERENCES = { daily_summary_enabled: false, budget_alert_enabled: false } as const;

function secondsUntil(target: number, now: number): number {
  return Math.max(Math.ceil((target - now) / 1000), 1);
}

function toVerifiedStatus(account: WhatsappAccountRecord): WhatsappStatus {
  return {
    status: 'verified',
    masked_phone: maskPhone(account.phoneE164),
    expires_at: null,
    verified_at: account.verifiedAt?.toISOString() ?? null,
    last_message_at: account.lastMessageAt?.toISOString() ?? null,
    preferences: {
      daily_summary_enabled: account.dailySummaryEnabled,
      budget_alert_enabled: account.budgetAlertEnabled,
    },
  };
}

export function createWhatsappService(deps: WhatsappServiceDeps) {
  const { repository, session, enqueueOutbound } = deps;
  const otp = deps.otp ?? defaultOtp;
  const clock = deps.now ?? (() => new Date());

  /** Batas harian dihitung dari OTP yang benar-benar dibuat (request dan resend sama-sama), bukan dari permintaan. */
  async function enforceDailyLimits(userId: string, phoneE164: string, now: Date): Promise<void> {
    const since = new Date(now.getTime() - OTP_WINDOW_MS);
    const [forPhone, forUser] = await Promise.all([
      repository.countVerificationsSince({ phoneE164 }, since),
      repository.countVerificationsSince({ userId }, since),
    ]);
    if (forPhone.count >= OTP_PER_PHONE_PER_DAY && forPhone.oldest) {
      throw AppError.rateLimited(
        secondsUntil(forPhone.oldest.getTime() + OTP_WINDOW_MS, now.getTime()),
        'Kode verifikasi untuk nomor ini sudah terlalu sering diminta hari ini. Coba lagi besok.',
      );
    }
    if (forUser.count >= OTP_PER_USER_PER_DAY && forUser.oldest) {
      throw AppError.rateLimited(
        secondsUntil(forUser.oldest.getTime() + OTP_WINDOW_MS, now.getTime()),
        'Anda sudah terlalu sering meminta kode verifikasi hari ini. Coba lagi besok.',
      );
    }
  }

  /** Jalur bersama request dan resend: 409 -> 429 -> 503 -> simpan -> antrekan. */
  async function issueCode(userId: string, phoneE164: string): Promise<LinkPending> {
    const now = clock();

    if (await repository.isPhoneVerifiedByAnyone(phoneE164)) {
      throw AppError.conflict('Nomor ini sudah dipakai akun lain', [{ field: 'phone', issue: 'phone_taken' }]);
    }
    await enforceDailyLimits(userId, phoneE164, now);

    // Sebelum menulis apa pun: OTP yang tidak mungkin terkirim tidak boleh menghabiskan kuota harian.
    if (!(await session.isConnected())) {
      throw AppError.unavailable(
        'Layanan WhatsApp kami sedang terputus, kode verifikasi belum bisa dikirim. ' +
          'Ini bukan kesalahan Anda; coba lagi beberapa saat lagi.',
      );
    }

    const code = otp.generateCode();
    const codeHash = await otp.hashCode(code);
    const waChatId = toWaChatId(phoneE164);
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

    await repository.upsertPendingAccount(userId, phoneE164, waChatId, now);
    await repository.createVerification(userId, { phoneE164, codeHash, expiresAt });
    await enqueueOutbound({ wa_chat_id: waChatId, text: buildOtpMessage(code) });

    return { status: 'pending', expires_at: expiresAt.toISOString(), masked_phone: maskPhone(phoneE164) };
  }

  /** Dipakai verify dan semua jalur yang menolak karena percobaan habis. */
  function attemptsExhausted(): AppError {
    return new AppError('RATE_LIMITED', 'Terlalu banyak percobaan salah. Minta kode baru.', [
      { field: 'code', issue: 'attempts_exhausted', attempts_left: 0 },
    ]);
  }

  return {
    async getStatus(userId: string): Promise<WhatsappStatus> {
      const account = await repository.findActiveAccount(userId);
      if (account?.status === 'verified') return toVerifiedStatus(account);

      if (account?.status === 'pending') {
        const verification = await repository.findPendingVerification(userId);
        // Kode kedaluwarsa: bagi pengguna tidak ada yang menunggu. Baris pending tetap ada dan
        // bisa dipakai ulang oleh `link/request` atau `link/resend`.
        if (verification && verification.expiresAt > clock()) {
          return {
            status: 'pending',
            masked_phone: maskPhone(account.phoneE164),
            expires_at: verification.expiresAt.toISOString(),
            verified_at: null,
            last_message_at: null,
            preferences: { ...DEFAULT_PREFERENCES },
          };
        }
      }
      return {
        status: 'unlinked',
        masked_phone: null,
        expires_at: null,
        verified_at: null,
        last_message_at: null,
        preferences: { ...DEFAULT_PREFERENCES },
      };
    },

    async requestLink(userId: string, input: LinkRequestInput): Promise<LinkPending> {
      const account = await repository.findActiveAccount(userId);
      if (account?.status === 'verified') {
        throw AppError.conflict('Akun ini sudah tertaut ke sebuah nomor. Putuskan tautan lebih dulu untuk mengganti nomor.', [
          { field: 'phone', issue: 'already_linked' },
        ]);
      }
      return issueCode(userId, input.phone);
    },

    async resendLink(userId: string): Promise<LinkPending> {
      const account = await repository.findActiveAccount(userId);
      if (account?.status !== 'pending') throw AppError.notFound(NO_PENDING_MESSAGE);

      const latest = await repository.findLatestVerification(userId);
      const now = clock().getTime();
      if (latest && now - latest.createdAt.getTime() < OTP_RESEND_GAP_MS) {
        throw AppError.rateLimited(
          secondsUntil(latest.createdAt.getTime() + OTP_RESEND_GAP_MS, now),
          'Tunggu sebentar sebelum meminta kode baru.',
        );
      }
      return issueCode(userId, account.phoneE164);
    },

    async verifyLink(userId: string, input: LinkVerifyInput): Promise<LinkVerified> {
      const now = clock();
      const account = await repository.findActiveAccount(userId);
      const verification = account?.status === 'pending' ? await repository.findPendingVerification(userId) : null;
      if (!verification || verification.expiresAt <= now) {
        throw AppError.notFound('Tidak ada kode yang menunggu, atau kodenya sudah kedaluwarsa. Minta kode baru.');
      }
      if (verification.attempts >= OTP_MAX_ATTEMPTS) throw attemptsExhausted();

      // Satu percobaan diambil SEBELUM kode dibandingkan, secara atomik. Bila dibandingkan dulu,
      // ratusan tebakan serentak sama-sama lolos pemeriksaan di atas dan batas lima percobaan
      // tidak berlaku. Tebakan yang benar ikut dihitung; tidak masalah.
      const attempts = await repository.incrementAttempts(userId, verification.id, OTP_MAX_ATTEMPTS);
      if (attempts === null) throw attemptsExhausted();

      if (!(await otp.verifyCode(input.code, verification.codeHash))) {
        throw AppError.validation('Kode salah', [
          { field: 'code', issue: 'invalid', attempts_left: OTP_MAX_ATTEMPTS - attempts },
        ]);
      }

      const result = await repository.completeVerification(userId, verification.id, now);
      if (result.outcome === 'already_used') {
        throw AppError.notFound('Kode ini sudah dipakai atau permintaannya dibatalkan. Minta kode baru.');
      }
      if (result.outcome === 'phone_taken') {
        throw AppError.conflict('Nomor ini sudah dipakai akun lain', [{ field: 'phone', issue: 'phone_taken' }]);
      }
      return {
        status: 'verified',
        phone: maskPhone(result.account.phoneE164),
        verified_at: (result.account.verifiedAt ?? now).toISOString(),
      };
    },

    async unlink(userId: string): Promise<void> {
      if (!(await repository.disableAccount(userId))) throw AppError.notFound('Tidak ada tautan WhatsApp yang aktif');
    },

    async updatePreferences(userId: string, input: PreferencesInput): Promise<WhatsappStatus> {
      const account = await repository.updatePreferences(userId, input);
      if (!account) throw AppError.notFound('Pengaturan hanya tersedia setelah nomor WhatsApp terverifikasi');
      return toVerifiedStatus(account);
    },
  };
}

export type WhatsappService = ReturnType<typeof createWhatsappService>;
