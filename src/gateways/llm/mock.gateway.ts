// LLM palsu untuk test: tanpa jaringan, tanpa penyedia. Respons diantrekan; antrean kosong
// mengembalikan klasifikasi confidence 0, seperti DisabledLlmGateway.

import type { LlmGateway } from './llm.gateway.js';

export interface MockLlmGateway extends LlmGateway {
  /** Teks yang pernah diklasifikasikan, urut panggil. */
  readonly calls: string[];
  /** Respons mentah untuk `classify` berikutnya (sekali pakai). */
  enqueue(response: unknown): void;
  /** `classify` berikutnya (sekali saja) melempar. */
  failNext(error?: Error): void;
  /** `classify` berikutnya (sekali saja) tidak pernah selesai; untuk menguji timeout. */
  hangNext(): void;
  reset(): void;
}

const IDLE = { intent: 'UNKNOWN', type: 'expense', category_hint: '', description: '', confidence: 0 };

export function createMockLlmGateway(): MockLlmGateway {
  const calls: string[] = [];
  const queue: Array<{ kind: 'value'; value: unknown } | { kind: 'error'; error: Error } | { kind: 'hang' }> = [];

  return {
    calls,

    async classify(text) {
      calls.push(text);
      const next = queue.shift();
      if (!next) return IDLE;
      if (next.kind === 'error') throw next.error;
      if (next.kind === 'hang') return new Promise<never>(() => undefined);
      return next.value;
    },

    enqueue(response) {
      queue.push({ kind: 'value', value: response });
    },

    failNext(error = new Error('mock: LLM gagal')) {
      queue.push({ kind: 'error', error });
    },

    hangNext() {
      queue.push({ kind: 'hang' });
    },

    reset() {
      calls.length = 0;
      queue.length = 0;
    },
  };
}
