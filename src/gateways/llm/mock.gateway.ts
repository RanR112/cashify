// LLM palsu untuk test: tanpa jaringan, tanpa penyedia. Respons diantrekan; antrean kosong
// mengembalikan klasifikasi confidence 0 (seperti DisabledLlmGateway) dan jawaban bebas kosong
// (sehingga percakapan memakai template).

import type { LlmGateway } from './llm.gateway.js';

export interface MockLlmGateway extends LlmGateway {
  /** Teks yang pernah diklasifikasikan, urut panggil. */
  readonly calls: string[];
  /** Teks yang pernah dijawab bebas, urut panggil. */
  readonly chatCalls: string[];
  /** Respons mentah untuk `classify` berikutnya (sekali pakai). */
  enqueue(response: unknown): void;
  /** Jawaban untuk `chat` berikutnya (sekali pakai). */
  enqueueChat(reply: string): void;
  /** `classify` berikutnya (sekali saja) melempar. */
  failNext(error?: Error): void;
  /** `chat` berikutnya (sekali saja) melempar. */
  failNextChat(error?: Error): void;
  /** `classify` berikutnya (sekali saja) tidak pernah selesai; untuk menguji timeout. */
  hangNext(): void;
  /** `chat` berikutnya (sekali saja) tidak pernah selesai; untuk menguji timeout. */
  hangNextChat(): void;
  reset(): void;
}

const IDLE = { intent: 'UNKNOWN', type: 'expense', category_hint: '', description: '', confidence: 0 };

type Step = { kind: 'value'; value: unknown } | { kind: 'error'; error: Error } | { kind: 'hang' };

function take(queue: Step[]): Step | undefined {
  return queue.shift();
}

export function createMockLlmGateway(): MockLlmGateway {
  const calls: string[] = [];
  const chatCalls: string[] = [];
  const queue: Step[] = [];
  const chatQueue: Step[] = [];

  return {
    calls,
    chatCalls,

    async classify(text) {
      calls.push(text);
      const next = take(queue);
      if (!next) return IDLE;
      if (next.kind === 'error') throw next.error;
      if (next.kind === 'hang') return new Promise<never>(() => undefined);
      return next.value;
    },

    async chat(text) {
      chatCalls.push(text);
      const next = take(chatQueue);
      if (!next) return '';
      if (next.kind === 'error') throw next.error;
      if (next.kind === 'hang') return new Promise<never>(() => undefined);
      return String(next.value);
    },

    enqueue(response) {
      queue.push({ kind: 'value', value: response });
    },

    enqueueChat(reply) {
      chatQueue.push({ kind: 'value', value: reply });
    },

    failNext(error = new Error('mock: LLM gagal')) {
      queue.push({ kind: 'error', error });
    },

    failNextChat(error = new Error('mock: LLM gagal')) {
      chatQueue.push({ kind: 'error', error });
    },

    hangNext() {
      queue.push({ kind: 'hang' });
    },

    hangNextChat() {
      chatQueue.push({ kind: 'hang' });
    },

    reset() {
      calls.length = 0;
      chatCalls.length = 0;
      queue.length = 0;
      chatQueue.length = 0;
    },
  };
}
