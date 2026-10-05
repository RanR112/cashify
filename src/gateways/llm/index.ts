import { DisabledLlmGateway } from './disabled.gateway.js';
import type { LlmGateway } from './llm.gateway.js';

export {
  LLM_CONFIDENCE_THRESHOLD,
  LLM_TIMEOUT_MS,
  LlmClassificationSchema,
  parseLlmOutput,
  safeClassify,
  type LlmClassification,
  type LlmGateway,
} from './llm.gateway.js';
export { DisabledLlmGateway } from './disabled.gateway.js';
export { createMockLlmGateway, type MockLlmGateway } from './mock.gateway.js';

/**
 * Gateway untuk composition root. Proyek ini berjalan tanpa layanan berbayar, jadi satu-satunya
 * pilihan adalah gateway yang dimatikan; menyalakan penyedia (tier gratis atau Ollama) cukup
 * mengganti isi fungsi ini, tidak ada modul lain yang berubah.
 */
export function createLlmGateway(): LlmGateway {
  return new DisabledLlmGateway();
}
