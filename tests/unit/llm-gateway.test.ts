// LlmGateway (aturan 2 dan 3): kontrak keluaran tanpa amount/date, validasi Zod, ambang
// confidence 0.7, timeout, dan implementasi default yang dimatikan. Tanpa jaringan.

import { describe, expect, it } from 'vitest';
import {
  createLlmGateway,
  createMockLlmGateway,
  DisabledLlmGateway,
  LLM_CONFIDENCE_THRESHOLD,
  LLM_TIMEOUT_MS,
  LlmClassificationSchema,
  parseLlmOutput,
  safeClassify,
} from '../../src/gateways/llm/index.js';

const valid = {
  intent: 'CREATE_TRANSACTION',
  type: 'expense',
  category_hint: 'makanan',
  description: 'makan nasi goreng',
  confidence: 0.92,
};

describe('LlmClassificationSchema: kontrak keluaran', () => {
  it('menerima bentuk dari ARCHITECTURE.md Bagian 7', () => {
    expect(parseLlmOutput(valid)).toEqual(valid);
  });

  it('tidak punya field amount maupun date (aturan 2)', () => {
    expect(Object.keys(LlmClassificationSchema.shape).sort()).toEqual([
      'category_hint',
      'confidence',
      'description',
      'intent',
      'type',
    ]);
  });

  it.each([
    ['amount', { amount: 25000 }],
    ['date', { date: '2026-09-30' }],
    ['field lain', { reply: 'Sudah dicatat Rp25.000' }],
  ])('keluaran yang membawa %s dibuang utuh, tidak dipangkas', (_name, extra) => {
    expect(parseLlmOutput({ ...valid, ...extra })).toBeNull();
  });

  it.each([
    ['intent di luar sembilan intent', { intent: 'TRANSFER' }],
    ['type di luar income/expense', { type: 'transfer' }],
    ['confidence di atas 1', { confidence: 1.5 }],
    ['confidence negatif', { confidence: -0.1 }],
    ['confidence berupa teks', { confidence: 'tinggi' }],
    ['field wajib hilang', { category_hint: undefined }],
  ])('gagal skema: %s', (_name, override) => {
    expect(parseLlmOutput({ ...valid, ...override })).toBeNull();
  });

  it.each([null, undefined, 'bukan objek', 42, []])('bukan objek: %j', (raw) => {
    expect(parseLlmOutput(raw)).toBeNull();
  });
});

describe('safeClassify: jatuh ke perilaku aman (null = tanya pengguna)', () => {
  it('mengembalikan klasifikasi yang valid dan cukup yakin', async () => {
    const gateway = createMockLlmGateway();
    gateway.enqueue(valid);
    expect(await safeClassify(gateway, 'ngopi sama temen')).toEqual(valid);
    expect(gateway.calls).toEqual(['ngopi sama temen']);
  });

  it('confidence tepat di ambang 0.7 dipakai', async () => {
    const gateway = createMockLlmGateway();
    gateway.enqueue({ ...valid, confidence: LLM_CONFIDENCE_THRESHOLD });
    expect(await safeClassify(gateway, 'x')).not.toBeNull();
  });

  it('confidence di bawah 0.7 memicu klarifikasi', async () => {
    const gateway = createMockLlmGateway();
    gateway.enqueue({ ...valid, confidence: 0.69 });
    expect(await safeClassify(gateway, 'x')).toBeNull();
  });

  it('keluaran tidak valid dibuang, termasuk yang menyelundupkan nominal', async () => {
    const gateway = createMockLlmGateway();
    gateway.enqueue({ ...valid, amount: 99999 });
    gateway.enqueue('Rp25.000 sudah dicatat');
    expect(await safeClassify(gateway, 'x')).toBeNull();
    expect(await safeClassify(gateway, 'x')).toBeNull();
  });

  it('galat penyedia tidak merambat', async () => {
    const gateway = createMockLlmGateway();
    gateway.failNext();
    expect(await safeClassify(gateway, 'x')).toBeNull();
  });

  it('melewati timeout: lanjut tanpa LLM', async () => {
    const gateway = createMockLlmGateway();
    gateway.hangNext();
    expect(await safeClassify(gateway, 'x', 20)).toBeNull();
  });

  it('batas waktu bawaan 3 detik', () => {
    expect(LLM_TIMEOUT_MS).toBe(3000);
  });
});

describe('DisabledLlmGateway: default proyek gratis (LOCAL-MODE.md)', () => {
  it('selalu confidence 0, jadi selalu jatuh ke klarifikasi', async () => {
    const gateway = new DisabledLlmGateway();
    const raw = await gateway.classify();
    expect(raw).toMatchObject({ confidence: 0 });
    expect(parseLlmOutput(raw)).not.toBeNull(); // bentuknya sah; ambang yang menolaknya
    expect(await safeClassify(gateway, 'apa pun')).toBeNull();
  });

  it('createLlmGateway() mengembalikan gateway yang dimatikan', () => {
    expect(createLlmGateway()).toBeInstanceOf(DisabledLlmGateway);
  });
});

describe('MockLlmGateway', () => {
  it('antrean kosong berperilaku seperti gateway yang dimatikan', async () => {
    const gateway = createMockLlmGateway();
    expect(await safeClassify(gateway, 'x')).toBeNull();
  });

  it('reset mengosongkan panggilan dan antrean', async () => {
    const gateway = createMockLlmGateway();
    gateway.enqueue(valid);
    await gateway.classify('a');
    gateway.enqueue(valid);
    gateway.reset();
    expect(gateway.calls).toEqual([]);
    expect(await safeClassify(gateway, 'b')).toBeNull();
  });
});
