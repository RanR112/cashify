import { describe, expect, it, vi } from 'vitest';
import { createOpenWaGateway } from '../../src/gateways/whatsapp/openwa.gateway.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(respond: () => Response | Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(async () => respond());
  const gateway = createOpenWaGateway({ baseUrl: 'http://localhost:8002/', apiKey: 'kunci-rahasia', fetch: fetchMock });
  return { gateway, fetchMock };
}

describe('OpenWA gateway: sendText', () => {
  it('memanggil POST /sendText dengan bentuk Easy API v4 dan header api_key', async () => {
    const { gateway, fetchMock } = setup(() => jsonResponse({ success: true, response: 'true_628@c.us_ABC' }));

    await gateway.sendText('628123456789@c.us', 'halo');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8002/sendText');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).api_key).toBe('kunci-rahasia');
    expect(JSON.parse(init?.body as string)).toEqual({ args: { to: '628123456789@c.us', content: 'halo' } });
  });

  it('melempar bila success false', async () => {
    const { gateway } = setup(() => jsonResponse({ success: false, error: 'nomor tidak terdaftar' }));
    await expect(gateway.sendText('628123456789@c.us', 'halo')).rejects.toThrow(/menolak/);
  });

  it('melempar bila HTTP bukan 2xx', async () => {
    const { gateway } = setup(() => jsonResponse({ success: false }, 500));
    await expect(gateway.sendText('628123456789@c.us', 'halo')).rejects.toThrow(/HTTP 500/);
  });

  it('melempar bila bentuk respons tidak dikenal', async () => {
    const { gateway } = setup(() => jsonResponse({ aneh: true }));
    await expect(gateway.sendText('628123456789@c.us', 'halo')).rejects.toThrow(/tidak dikenal/);
  });

  it('galat jaringan dilempar tanpa membocorkan nomor penuh atau isi pesan', async () => {
    const { gateway } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const error = await gateway.sendText('628123456789@c.us', 'Kode verifikasi: 483920').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('483920');
    expect((error as Error).message).not.toContain('628123456789');
  });
});

describe('OpenWA gateway: getStatus', () => {
  it('CONNECTED berarti terhubung', async () => {
    const { gateway, fetchMock } = setup(() => jsonResponse({ success: true, response: 'CONNECTED' }));
    expect(await gateway.getStatus()).toEqual({ connected: true });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8002/getConnectionState');
  });

  it.each(['TIMEOUT', 'CONFLICT', 'UNPAIRED', 'DISCONNECTED'])('%s berarti terputus', async (state) => {
    const { gateway } = setup(() => jsonResponse({ success: true, response: state }));
    const status = await gateway.getStatus();
    expect(status.connected).toBe(false);
    expect(status.detail).toContain(state);
  });

  it('tidak pernah melempar: galat jaringan, HTTP 500, dan respons aneh semuanya terputus', async () => {
    for (const respond of [
      () => {
        throw new TypeError('ECONNREFUSED');
      },
      () => jsonResponse({}, 500),
      () => jsonResponse({ aneh: true }),
      () => new Response('bukan json', { status: 200 }),
    ]) {
      const { gateway } = setup(respond);
      expect((await gateway.getStatus()).connected).toBe(false);
    }
  });
});
