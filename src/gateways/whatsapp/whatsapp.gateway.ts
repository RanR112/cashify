// Satu-satunya pintu ke WhatsApp (aturan 10): service tidak pernah memanggil OpenWA langsung.
// Interface ini sengaja hanya dua method. Menambah method berarti menambah hal yang harus
// ditiru mock dan diganti bila OpenWA diganti, jadi tambahkan hanya bila benar-benar dibutuhkan.

export interface WhatsAppStatus {
  /** True hanya bila sesi bot tersambung dan siap mengirim. */
  connected: boolean;
  /** Keterangan untuk log atau pesan galat; tidak untuk ditampilkan ke pengguna. */
  detail?: string;
}

export interface WhatsAppGateway {
  /**
   * Mengirim teks ke `to` (wa_chat_id, mis. "628123456789@c.us"). Melempar bila gagal.
   * Pemanggilnya worker `outbound`, yang menerapkan concurrency 1 dan jeda acak (aturan 12);
   * jangan memanggil ini dari jalur request HTTP.
   */
  sendText(to: string, body: string): Promise<void>;

  /** Status sesi bot. Tidak pernah melempar: gangguan jaringan berarti `connected: false`. */
  getStatus(): Promise<WhatsAppStatus>;
}
