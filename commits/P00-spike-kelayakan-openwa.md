# P00 · Spike kelayakan OpenWA

Satu commit.

---

## 1. Spike perekam webhook OpenWA v4

```bash
git add spike/.gitignore \
        spike/README.md \
        spike/package.json \
        spike/package-lock.json \
        spike/tsconfig.json \
        spike/src/receiver.ts \
        spike/src/send-reply.ts \
        spike/src/ram-logger.ts \
        commits/P00-spike-kelayakan-openwa.md
```

```
chore(spike): perekam payload webhook OpenWA v4.76.0

- Versi @open-wa/wa-automate dipin persis 4.76.0 karena bentuk payload
  v4 berbeda dari dokumentasi v5 dan harus direkam dari instance nyata
- Penerima Express menyimpan body mentah tanpa parsing, supaya tidak
  ada asumsi bentuk yang menyelinap sebelum rekaman ada
- Pencatat RAM tiap 60 detik untuk menilai kelayakan berjalan lokal
```

---

## Catatan

- Berkas baru: 9 (termasuk catatan ini)
- **`git status` tidak bisa dijalankan**: `backend/` belum berupa repositori git (`fatal: not a git repository`). Daftar berkas di atas diambil dari isi disk, dengan `node_modules/` dikecualikan. Periksa ulang dengan `git status` setelah repositori ada.
- `CLAUDE.md`, `PROMPTS.md`, dan `claude/` sudah ada sebelum tahap ini dan tidak di-stage di sini.
- Sengaja tidak di-stage: `spike/node_modules/` (dan `spike/recordings/`, `spike/ram-usage.csv` bila sudah terbentuk), semuanya ada di `spike/.gitignore`.
- Dependensi baru (`@open-wa/wa-automate`, `express`, `tsx`, `typescript`, `@types/*`) hanya di `spike/package.json`, atas permintaan eksplisit prompt P0.
- Rekaman payload nyata belum ada: butuh QR dipindai dengan nomor cadangan oleh pengguna.
