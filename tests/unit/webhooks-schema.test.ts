// Skema dan keputusan saring webhook, diuji dengan payload v4 nyata (tests/fixtures/openwa/).

import { describe, expect, it, vi } from 'vitest';
import { inboundMessageSchema, webhookEnvelopeSchema } from '../../src/modules/webhooks/webhooks.schema.js';
import { openwaFixture } from '../helpers/openwaFixtures.js';

// controller mengimpor logger -> env (process.exit bila .env tidak dimuat).
vi.mock('../../src/config/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
const { classify } = await import('../../src/modules/webhooks/webhooks.controller.js');

describe('amplop webhook v4', () => {
  it('menerima semua event yang terekam, termasuk yang `data`-nya bukan pesan', () => {
    for (const name of [
      'dm-on-message',
      'dm-on-any-message',
      'image-on-message',
      'bot-reply-on-any-message',
      'bot-reply-on-ack',
      'group-ciphertext-on-message',
      'group-chat-on-message',
    ] as const) {
      expect(webhookEnvelopeSchema.safeParse(openwaFixture(name)).success, name).toBe(true);
    }
    expect(webhookEnvelopeSchema.safeParse({ event: 'onStateChanged', sessionId: 'session', data: 'CONNECTED' }).success).toBe(true);
  });

  it('menolak amplop tanpa event atau sessionId, dan yang bukan objek', () => {
    expect(webhookEnvelopeSchema.safeParse({ sessionId: 'session', data: {} }).success).toBe(false);
    expect(webhookEnvelopeSchema.safeParse({ event: 'onMessage', data: {} }).success).toBe(false);
    expect(webhookEnvelopeSchema.safeParse([]).success).toBe(false);
    expect(webhookEnvelopeSchema.safeParse('onMessage').success).toBe(false);
    expect(webhookEnvelopeSchema.safeParse(null).success).toBe(false);
  });

  it('mempertahankan field yang tidak dikenal (raw_payload menyimpannya utuh)', () => {
    const parsed = webhookEnvelopeSchema.parse(openwaFixture('dm-on-message'));
    expect(parsed['webhook_id']).toBeTypeOf('string');
    expect((parsed.data as { sender: { phoneNumber: string } }).sender.phoneNumber).toBe('628123456789@c.us');
  });
});

describe('data onMessage', () => {
  it('membaca bentuk v4: chatId berupa LID, bukan nomor telepon', () => {
    const message = inboundMessageSchema.parse(openwaFixture('dm-on-message').data);
    expect(message.chatId).toMatch(/@lid$/);
    expect(message.id).toMatch(/^false_\d+@lid_[0-9A-F]{32}$/);
    expect(message).toMatchObject({ type: 'chat', fromMe: false, isGroupMsg: false, body: 'tadi makan siang 25 ribu' });
  });

  it('menolak data tanpa id, chatId, type, atau fromMe', () => {
    for (const field of ['id', 'chatId', 'type', 'fromMe']) {
      const data = openwaFixture('dm-on-message').data;
      delete data[field];
      expect(inboundMessageSchema.safeParse(data).success, field).toBe(false);
    }
  });
});

describe('classify', () => {
  const decide = (name: Parameters<typeof openwaFixture>[0], mutate?: (e: ReturnType<typeof openwaFixture>) => void) => {
    const envelope = openwaFixture(name);
    mutate?.(envelope);
    return classify(webhookEnvelopeSchema.parse(envelope));
  };

  it('menyimpan pesan chat pribadi', () => {
    const decision = decide('dm-on-message');
    expect(decision.action).toBe('store');
  });

  it('menyimpan gambar (jenis lain tetap disimpan; worker yang membalas "belum didukung")', () => {
    expect(decide('image-on-message')).toMatchObject({ action: 'store', message: { type: 'image' } });
  });

  it('mengabaikan onAnyMessage dan onAck: satu pesan datang dua kali dengan id sama', () => {
    expect(decide('dm-on-any-message')).toEqual({ action: 'ignore', reason: 'event_ignored' });
    expect(decide('bot-reply-on-any-message')).toEqual({ action: 'ignore', reason: 'event_ignored' });
    expect(decide('bot-reply-on-ack')).toEqual({ action: 'ignore', reason: 'event_ignored' });
  });

  it('mengabaikan event asing dengan alasan terpisah (untuk dicatat di level info)', () => {
    expect(classify(webhookEnvelopeSchema.parse({ event: 'onStateChanged', sessionId: 's', data: 'CONNECTED' }))).toEqual({
      action: 'ignore',
      reason: 'event_unknown',
    });
  });

  it('mengabaikan fromMe: true (aturan 6)', () => {
    expect(decide('dm-on-message', (e) => (e.data['fromMe'] = true))).toEqual({ action: 'ignore', reason: 'from_me' });
  });

  it('mengabaikan pesan grup', () => {
    expect(decide('group-chat-on-message')).toEqual({ action: 'ignore', reason: 'group' });
  });

  it('mengabaikan ciphertext: id-nya sama dengan pesan asli yang menyusul', () => {
    const ciphertext = openwaFixture('group-ciphertext-on-message');
    const real = openwaFixture('group-chat-on-message');
    expect(ciphertext.data['id']).toBe(real.data['id']);
    expect(ciphertext.data['type']).toBe('ciphertext');
    expect(classify(webhookEnvelopeSchema.parse(ciphertext))).toEqual({ action: 'ignore', reason: 'group' });

    // Di chat pribadi pun ciphertext harus diabaikan, bukan hanya di grup.
    const dmCiphertext = openwaFixture('dm-on-message');
    dmCiphertext.data['type'] = 'ciphertext';
    dmCiphertext.data['body'] = '';
    expect(classify(webhookEnvelopeSchema.parse(dmCiphertext))).toEqual({ action: 'ignore', reason: 'ciphertext' });
  });

  it('melempar bila data onMessage tidak berbentuk pesan (dijawab 400 oleh errorHandler)', () => {
    const envelope = webhookEnvelopeSchema.parse({ event: 'onMessage', sessionId: 's', data: { body: 'x' } });
    expect(() => classify(envelope)).toThrow();
  });
});
