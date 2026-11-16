// Gateway LLM ke penyedia (Groq, kompatibel OpenAI). Menguji bentuk request, pemotongan input,
// penolakan respons yang tidak dikenal, dan bahwa kegagalannya berujung pada perilaku aman
// lewat `safeClassify`. Tanpa jaringan: `fetch` disuntik.

import { describe, expect, it, vi } from 'vitest';
import {
  createGroqLlmGateway,
  GROQ_BASE_URL,
  LLM_CHAT_MAX_TOKENS,
  LLM_CHAT_SYSTEM_PROMPT,
  LLM_DEFAULT_MODEL,
  LLM_MAX_INPUT_CHARS,
  LLM_SYSTEM_PROMPT,
  parseLlmOutput,
  safeChat,
  safeClassify,
  type GroqGatewayOptions,
} from '../../src/gateways/llm/index.js';

const classification = {
  intent: 'CREATE_TRANSACTION',
  type: 'expense',
  category_hint: 'makanan',
  description: 'ngopi sama temen',
  confidence: 0.9,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Amplop respons penyedia: konten JSON ada di `choices[0].message.content`. */
function completion(content: unknown): Response {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify(content) } }] });
}

/** Amplop jawaban bebas: `content` adalah teks biasa, bukan JSON. */
function textCompletion(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

function setup(respond: () => Response | Promise<Response>, options: Partial<GroqGatewayOptions> = {}) {
  const fetchMock = vi.fn<typeof fetch>(async () => respond());
  const gateway = createGroqLlmGateway({ apiKey: 'kunci-rahasia', fetch: fetchMock, ...options });
  return { gateway, fetchMock };
}

/** Body yang dikirim ke penyedia pada panggilan ke-`index`. */
function sentBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[index]![1] as RequestInit).body as string) as Record<string, unknown>;
}

describe('Groq LlmGateway: bentuk request', () => {
  it('memanggil POST /chat/completions dengan Bearer dan mode JSON', async () => {
    const { gateway, fetchMock } = setup(() => completion(classification));

    expect(await gateway.classify('ngopi sama temen 25rb')).toEqual(classification);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${GROQ_BASE_URL}/chat/completions`);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer kunci-rahasia');
    const body = sentBody(fetchMock);
    expect(body.model).toBe(LLM_DEFAULT_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('mengirim instruksi sistem dan hanya teks pesan sebagai pesan pengguna', async () => {
    const { gateway, fetchMock } = setup(() => completion(classification));
    await gateway.classify('makan siang 25 ribu');

    const messages = sentBody(fetchMock).messages as Array<{ role: string; content: string }>;
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[0]!.content).toBe(LLM_SYSTEM_PROMPT);
    // Yang dikirim hanya teks pesan: tanpa user_id, nomor, atau riwayat transaksi.
    expect(messages[1]!.content).toBe('makan siang 25 ribu');
  });

  it.each<[string, Partial<GroqGatewayOptions>, string]>([
    ['base URL', { baseUrl: 'https://contoh.test/v1/' }, 'https://contoh.test/v1/chat/completions'],
    ['model', { model: 'model-lain' }, `${GROQ_BASE_URL}/chat/completions`],
  ])('menghormati konfigurasi %s', async (_name, options, expectedUrl) => {
    const { gateway, fetchMock } = setup(() => completion(classification), options);
    await gateway.classify('x');

    expect(fetchMock.mock.calls[0]![0]).toBe(expectedUrl);
    expect(sentBody(fetchMock).model).toBe(options.model ?? LLM_DEFAULT_MODEL);
  });

  it(`memotong input pada ${LLM_MAX_INPUT_CHARS} karakter`, async () => {
    const { gateway, fetchMock } = setup(() => completion(classification));
    await gateway.classify('a'.repeat(LLM_MAX_INPUT_CHARS + 250));

    const messages = sentBody(fetchMock).messages as Array<{ content: string }>;
    expect(messages[1]!.content).toHaveLength(LLM_MAX_INPUT_CHARS);
  });
});

describe('Groq LlmGateway: respons yang tidak layak', () => {
  it('melempar bila HTTP bukan 2xx', async () => {
    const { gateway } = setup(() => jsonResponse({ error: 'unauthorized' }, 401));
    await expect(gateway.classify('x')).rejects.toThrow(/HTTP 401/);
  });

  it.each([
    ['amplop tanpa choices', { aneh: true }],
    ['choices kosong', { choices: [] }],
    ['content bukan string', { choices: [{ message: { content: 42 } }] }],
  ])('melempar bila %s', async (_name, body) => {
    const { gateway } = setup(() => jsonResponse(body));
    await expect(gateway.classify('x')).rejects.toThrow(/tidak dikenal/);
  });

  it('melempar bila konten bukan JSON', async () => {
    const { gateway } = setup(() => jsonResponse({ choices: [{ message: { content: 'Rp25.000 sudah dicatat' } }] }));
    await expect(gateway.classify('x')).rejects.toThrow();
  });
});

describe('Groq LlmGateway: lewat safeClassify', () => {
  it('keluaran sah diteruskan apa adanya', async () => {
    const { gateway } = setup(() => completion(classification));
    expect(await safeClassify(gateway, 'ngopi sama temen')).toEqual(classification);
  });

  it('keluaran yang menyelundupkan amount dibuang utuh', async () => {
    const { gateway } = setup(() => completion({ ...classification, amount: 99_999 }));
    expect(parseLlmOutput({ ...classification, amount: 99_999 })).toBeNull();
    expect(await safeClassify(gateway, 'x')).toBeNull();
  });

  it('confidence di bawah ambang memicu klarifikasi', async () => {
    const { gateway } = setup(() => completion({ ...classification, confidence: 0.4 }));
    expect(await safeClassify(gateway, 'x')).toBeNull();
  });

  it('galat penyedia tidak merambat', async () => {
    const { gateway } = setup(() => {
      throw new TypeError('fetch failed');
    });
    expect(await safeClassify(gateway, 'x')).toBeNull();
  });

  it('timeout penyedia jatuh ke perilaku aman', async () => {
    // Penyedia tidak pernah menjawab; AbortSignal.timeout membatalkan permintaan.
    const { gateway } = setup(
      () => new Promise<Response>(() => undefined) as unknown as Response,
      { timeoutMs: 20 },
    );
    expect(await safeClassify(gateway, 'x', 60)).toBeNull();
  });
});

describe('Groq LlmGateway: jawaban bebas (LLM_REPLY_MODE=freeform)', () => {
  const reply = 'Halo! Saya asisten Cashify. Ada yang bisa saya bantu?';

  /** Gateway Groq selalu punya `chat`; kontraknya opsional agar `disabled` bisa tanpa chat. */
  async function chat(gateway: ReturnType<typeof createGroqLlmGateway>, text: string): Promise<string> {
    if (!gateway.chat) throw new Error('gateway tanpa chat');
    return gateway.chat(text);
  }

  it('memakai prompt asisten, tanpa mode JSON, dan hanya teks pesan', async () => {
    const { gateway, fetchMock } = setup(() => textCompletion(reply));

    expect(await chat(gateway, 'halo')).toBe(reply);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${GROQ_BASE_URL}/chat/completions`);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer kunci-rahasia');
    const body = sentBody(fetchMock);
    expect(body.model).toBe(LLM_DEFAULT_MODEL);
    expect(body.response_format).toBeUndefined();
    expect(body.max_tokens).toBe(LLM_CHAT_MAX_TOKENS);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toBe(LLM_CHAT_SYSTEM_PROMPT);
    expect(messages[1]!.content).toBe('halo');
  });

  it('memotong input pada batas yang sama dengan klasifikasi', async () => {
    const { gateway, fetchMock } = setup(() => textCompletion(reply));
    await chat(gateway, 'a'.repeat(LLM_MAX_INPUT_CHARS + 100));
    const messages = sentBody(fetchMock).messages as Array<{ content: string }>;
    expect(messages[1]!.content).toHaveLength(LLM_MAX_INPUT_CHARS);
  });

  it('HTTP non-2xx melempar dan safeChat mengembalikan null', async () => {
    const { gateway } = setup(() => jsonResponse({ error: 'rate limited' }, 429));
    await expect(chat(gateway, 'x')).rejects.toThrow(/HTTP 429/);
    expect(await safeChat(gateway, 'x')).toBeNull();
  });

  it('jawaban bersih diteruskan safeChat; jawaban bernominal dibuang', async () => {
    const clean = setup(() => textCompletion(reply));
    expect(await safeChat(clean.gateway, 'halo')).toBe(reply);

    const money = setup(() => textCompletion('Saldo kamu Rp25.000 ya.'));
    expect(await safeChat(money.gateway, 'berapa saldoku')).toBeNull();
  });
});

