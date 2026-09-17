# USD to IDR Misskey Bot

Bot otomatis berbasis Node.js yang memantau dan memposting informasi kurs **USD (Dolar AS) ke IDR (Rupiah Indonesia)** beserta grafik pergerakan harga terbaru ke platform **Misskey**.

## ⚙️ Cara Kerja Bot

1. **Koneksi WebSocket Real-Time (24/7)**:
   - Bot terhubung ke WebSocket streaming Investing.com untuk memantau pergerakan harga USD/IDR secara langsung.
   - Dilengkapi *heartbeat* otomatis dan timer *watchdog* anti-zombie untuk memulihkan koneksi jika jaringan terputus.

2. **Penyimpanan Riwayat Kurs ke SQLite (Candle 15 Menit)**:
   - Setiap tick harga dirangkum (*bucketed*) menjadi candle **OHLC (Open, High, Low, Close)** per interval 15 menit.
   - Disimpan secara persisten ke database SQLite lokal (`data/kurs.db`) menggunakan kueri *upsert*, menjaga database tetap ramping (< 5 MB/tahun) dan bebas pembengkakan.

3. **Pengecekan Rekor ATH Instan**:
   - Setiap perubahan harga langsung dievaluasi di memori. Jika kurs menembus rekor ATH baru kelipatan 100 (contoh: Rp 17.600 $\rightarrow$ Rp 17.700), bot langsung memposting notifikasi rekor baru ke Misskey.

4. **Laporan Penutupan Harian & Auto-Sync**:
   - **Posting Harian (Senin–Sabtu 16:00 WIB)**: Membuat gambar grafik chart dan caption laporan penutupan harian murni langsung dari database SQLite secara *offline-ready*.
   - **Sinkronisasi Fetch API**: Saat bot pertama kali dijalankan atau jika WebSocket sempat terputus lebih dari 15 menit, sistem otomatis mengambil 160 titik candle historis via Fetch API untuk menambal data yang terlewat.

## 🛠️ Persyaratan Sistem

- **Node.js**: v24+ atau versi lebih baru
- **pnpm**: v10+ (atau npm/yarn/bun)

---

## 🚀 Cara Install & Konfigurasi

### 1. Clone & Install Dependensi

```bash
pnpm install
```

### 2. Konfigurasi Environment Variable

Salin file `.env.sample` menjadi `.env`:

```bash
cp .env.sample .env
```

Buka file `.env` dan lengkapi konfigurasi berikut:

```env
MISSKEY_API_BASE_URL=https://misskey.id/api
MISSKEY_ACCESS_TOKEN=your_misskey_access_token_here
MISSKEY_FOLDER_ID=your_folder_id_optional

CRON_TIMEZONE=Asia/Jakarta
USER_AGENT=USDtoIDR-Bot
```

---

## 💻 Cara Menjalankan

### Menjalankan Bot (Mode Normal)

Bot akan berjalan secara berkelanjutan di latar belakang sesuai jadwal cron:

```bash
pnpm start
# atau
npm run start
```

### Mode Testing (CLI)

Untuk melakukan pengujian posting note tanpa menunggu jadwal cron:

- **Test Posting Harian (default visibility: `specified`)**:

  ```bash
  pnpm test
  # atau
  npm run test
  ```

- **Test Pengecekan ATH (default visibility: `specified`)**:

  ```bash
  pnpm run test-ath
  # atau
  pnpm run test:ath
  ```

### Parameter Custom Visibility pada Mode Testing

Secara default, mode testing menggunakan visibilitas `specified` agar pengujian tidak mengotori linimasa publik Misskey. Anda dapat menentukan visibilitas kustom (`public`, `home`, `followers`, `specified`) secara fleksibel:

- **Test Posting Harian dengan Visibilitas Kustom**:

  ```bash
  # Menggunakan pnpm
  pnpm test public
  pnpm test home
  ```

- **Test Pengecekan ATH dengan Visibilitas Kustom**:

  ```bash
  # Menggunakan pnpm
  pnpm run test-ath public
  pnpm run test-ath specified
  ```
---

## 📄 Lisensi

[MIT License](LICENSE.md)
