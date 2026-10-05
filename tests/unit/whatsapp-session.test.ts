import { describe, expect, it, vi } from 'vitest';

// whatsapp.session.ts mengimpor logger -> env (process.exit bila .env tidak dimuat).
vi.mock('../../src/config/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { createSessionMonitor } = await import('../../src/modules/whatsapp/whatsapp.session.js');

function setup(options: { connected?: boolean; upsertFails?: boolean } = {}) {
  let connected = options.connected ?? true;
  let clock = 1_000_000;
  const getStatus = vi.fn(async () => (connected ? { connected: true } : { connected: false, detail: 'putus' }));
  const upsertSession = vi.fn(async () => {
    if (options.upsertFails) throw new Error('database mati');
  });
  const monitor = createSessionMonitor({
    gateway: { getStatus },
    repository: { upsertSession },
    sessionId: 'myfinance-bot',
    ttlMs: 10_000,
    now: () => clock,
  });
  return {
    monitor,
    getStatus,
    upsertSession,
    setConnected: (value: boolean) => (connected = value),
    advance: (ms: number) => (clock += ms),
  };
}

describe('session monitor', () => {
  it('memakai hasil yang masih segar tanpa memanggil gateway lagi', async () => {
    const { monitor, getStatus, advance } = setup();
    expect(await monitor.isConnected()).toBe(true);
    advance(9_000);
    expect(await monitor.isConnected()).toBe(true);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('memeriksa ulang setelah TTL lewat dan melihat perubahan status', async () => {
    const { monitor, getStatus, setConnected, advance } = setup();
    expect(await monitor.isConnected()).toBe(true);
    setConnected(false);
    advance(10_001);
    expect(await monitor.isConnected()).toBe(false);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('permintaan serentak berbagi satu pemeriksaan', async () => {
    const { monitor, getStatus } = setup();
    await Promise.all([monitor.isConnected(), monitor.isConnected(), monitor.isConnected()]);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('mencatat status ke whatsapp_sessions dengan nama sesi', async () => {
    const { monitor, upsertSession } = setup({ connected: false });
    await monitor.isConnected();
    expect(upsertSession).toHaveBeenCalledWith(
      { sessionId: 'myfinance-bot', connected: false, detail: 'putus' },
      expect.any(Date),
    );
  });

  it('gagal mencatat ke database tidak mengubah jawaban', async () => {
    const { monitor } = setup({ upsertFails: true });
    await expect(monitor.isConnected()).resolves.toBe(true);
  });

  it('sessionId boleh berupa fungsi', async () => {
    const upsertSession = vi.fn(async () => undefined);
    const monitor = createSessionMonitor({
      gateway: { getStatus: async () => ({ connected: true }) },
      repository: { upsertSession },
      sessionId: async () => 'dari-env',
    });
    await monitor.isConnected();
    expect(upsertSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'dari-env' }), expect.any(Date));
  });
});
