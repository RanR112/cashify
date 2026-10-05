// Implementasi default (LOCAL-MODE.md): LLM dimatikan. Selalu confidence 0, sehingga kamus yang
// gagal mengenali pesan berujung pada pertanyaan ke pengguna, bukan tebakan.

import type { LlmClassification, LlmGateway } from './llm.gateway.js';

export class DisabledLlmGateway implements LlmGateway {
  async classify(): Promise<LlmClassification> {
    return {
      intent: 'UNKNOWN',
      type: 'expense',
      category_hint: '',
      description: '',
      confidence: 0,
    };
  }
}
