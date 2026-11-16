import { DisabledLlmGateway } from './disabled.gateway.js';
import { createGroqLlmGateway } from './groq.gateway.js';
import type { LlmGateway } from './llm.gateway.js';

export {
  LLM_CHAT_MAX_CHARS,
  LLM_CHAT_MAX_TOKENS,
  LLM_CONFIDENCE_THRESHOLD,
  LLM_MAX_INPUT_CHARS,
  LLM_TIMEOUT_MS,
  LlmClassificationSchema,
  LlmRequestError,
  parseLlmOutput,
  safeChat,
  safeClassify,
  sanitizeChatReply,
  type LlmClassification,
  type LlmGateway,
  type LlmOutcome,
  type LlmOutcomeObserver,
} from './llm.gateway.js';
export { DisabledLlmGateway } from './disabled.gateway.js';
export { createMockLlmGateway, type MockLlmGateway } from './mock.gateway.js';
export {
  createGroqLlmGateway,
  GROQ_BASE_URL,
  LLM_CHAT_SYSTEM_PROMPT,
  LLM_DEFAULT_MODEL,
  LLM_SYSTEM_PROMPT,
  type GroqGatewayOptions,
} from './groq.gateway.js';

/** Penyedia yang didukung. `disabled` berarti tanpa jaringan sama sekali (LOCAL-MODE.md). */
export type LlmProvider = 'disabled' | 'groq';

/** Mode balasan WhatsApp; lihat `LLM_REPLY_MODE` di config/env.ts dan SYSTEM_DOCUMENTATION.md 10.5. */
export type LlmReplyMode = 'template' | 'freeform';

export interface LlmConfig {
  provider: LlmProvider;
  /** Diperlukan bila `provider` bukan `disabled`; sudah divalidasi config/env.ts. */
  apiKey?: string | undefined;
  /** Kosong berarti bawaan penyedia (GROQ_BASE_URL). */
  baseUrl?: string | undefined;
  /** Kosong berarti bawaan penyedia (LLM_DEFAULT_MODEL). */
  model?: string | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Gateway untuk composition root (src/worker.ts). Bawaannya tetap `DisabledLlmGateway`: tanpa
 * konfigurasi, tidak ada satu pun request jaringan keluar. LLM hanya dipakai worker, tidak pernah
 * proses API (Bagian 8).
 */
export function createLlmGateway(config?: LlmConfig): LlmGateway {
  if (!config || config.provider === 'disabled') return new DisabledLlmGateway();
  if (!config.apiKey) throw new Error('LLM_API_KEY wajib diisi bila LLM_PROVIDER bukan "disabled"');
  return createGroqLlmGateway({
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
    ...(config.model !== undefined && { model: config.model }),
    ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
  });
}
