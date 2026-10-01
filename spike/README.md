# Spike P0 — Kelayakan OpenWA v4.76.0

Spike buangan. Tujuan: **merekam bentuk payload webhook v4 yang sebenarnya**. Jangan salin bentuk dari openwa.dev (itu v5).

## Persiapan

```bash
cd spike
npm install
```

Perlu satu nomor WhatsApp **cadangan** (bukan nomor pribadi).

## Menjalankan (tiga terminal, semua di `spike/`)

1. **Penerima webhook** — mencatat body mentah ke `recordings/`:
   ```bash
   npm run receiver
   ```
2. **OpenWA** (webhook `-w` ke `http://localhost:3000/webhook`, Easy API di port 8002):
   ```bash
   npm run openwa
   ```
3. **Pencatat RAM** — tiap 60 detik ke `ram-usage.csv`:
   ```bash
   npm run ram
   ```

Jalankan penerima lebih dulu supaya tidak ada pesan yang terlewat.

## Memindai QR

1. Setelah `npm run openwa` jalan, QR muncul di terminal (dan sebagai `qr_code.png` di folder kerja bila terminal merusak tampilannya).
2. Di HP nomor cadangan: WhatsApp → **Perangkat tertaut** → **Tautkan perangkat** → pindai QR.
3. Tunggu log OpenWA menyatakan klien siap.

## Memancing payload

Kirim pesan ke nomor bot dari nomor lain. Coba beberapa jenis: teks biasa, teks panjang, emoji, balasan (quote), gambar, pesan dari grup, dan pesan yang bot kirim sendiri (untuk melihat `fromMe`).

Kirim balasan lewat Easy API:

```bash
npm run reply -- 628123456789@c.us "halo dari bot"
```

Swagger Easy API ada di `http://localhost:8002/api-docs`. Bila bentuk request `/sendText` berbeda dari yang dipakai `src/send-reply.ts`, ikuti Swagger.

## Memeriksa hasil

- `recordings/<waktu>-<nomor>.json` — satu berkas per request: `receivedAt`, `headers`, dan `rawBody` (string mentah, belum di-parse).
- Lihat body sebagai JSON:
  ```bash
  node -e "console.log(JSON.stringify(JSON.parse(require('./recordings/BERKAS.json').rawBody), null, 2))"
  ```
- Catat: nama event, nama field pengirim, id pesan, teks, timestamp, penanda `fromMe`, ada tidaknya header rahasia, dan apakah satu pesan menghasilkan lebih dari satu request (kiriman ulang).
- `ram-usage.csv` — kolom `timestamp,process_count,total_mb` (proses OpenWA + turunannya, termasuk Chromium). `0,0` berarti OpenWA belum jalan. Biarkan berjalan beberapa jam untuk melihat tren.

## Berhenti

`Ctrl+C` di tiap terminal. Folder `spike/` boleh dihapus setelah rekaman dipindahkan ke `claude/` sebagai acuan.
