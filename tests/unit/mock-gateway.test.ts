import { describe, expect, it } from 'vitest';
import { createMockGateway } from '../../src/gateways/whatsapp/mock.gateway.js';

describe('mock gateway', () => {
  it('merekam pesan terkirim sesuai urutan', async () => {
    const gateway = createMockGateway();
    await gateway.sendText('628111@c.us', 'satu');
    await gateway.sendText('628222@c.us', 'dua');
    expect(gateway.sent).toEqual([
      { to: '628111@c.us', body: 'satu' },
      { to: '628222@c.us', body: 'dua' },
    ]);
  });

  it('terhubung secara bawaan dan bisa diputus', async () => {
    const gateway = createMockGateway();
    expect((await gateway.getStatus()).connected).toBe(true);
    gateway.setConnected(false);
    expect((await gateway.getStatus()).connected).toBe(false);
  });

  it('failNextSend hanya menggagalkan satu pengiriman dan tidak merekamnya', async () => {
    const gateway = createMockGateway();
    gateway.failNextSend();
    await expect(gateway.sendText('628111@c.us', 'gagal')).rejects.toThrow();
    await gateway.sendText('628111@c.us', 'berhasil');
    expect(gateway.sent).toEqual([{ to: '628111@c.us', body: 'berhasil' }]);
  });

  it('reset mengembalikan keadaan awal', async () => {
    const gateway = createMockGateway();
    await gateway.sendText('628111@c.us', 'x');
    gateway.setConnected(false);
    gateway.reset();
    expect(gateway.sent).toHaveLength(0);
    expect((await gateway.getStatus()).connected).toBe(true);
  });
});
