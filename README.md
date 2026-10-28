# USD to IDR Misskey Bot

Bot otomatis berbasis Node.js yang memantau dan memposting informasi kurs **USD (Dolar AS) ke IDR (Rupiah Indonesia)** beserta grafik pergerakan harga terbaru ke platform **Misskey**.

## ⚙️ Cara Kerja Singkat

```mermaid
flowchart LR
    WS[WebSocket Live 24/7] --> DB[(SQLite Lokal<br/>Logging)]
    WS -->|Deteksi ATH Kelipatan 100| ATH[Alert Rekor ATH]
    API[Fetch API Investing.com] --> DAILY[Laporan Harian 16:00 WIB<br/>+ Grafik Mingguan]
    API -.->|Ambil Grafik| ATH
    DAILY --> MISSKEY[Linimasa Misskey]
    ATH --> MISSKEY
```

| Komponen | Deskripsi |
|---|---|
| **WebSocket & Logging** | Streaming harga live 24/7 dari Investing.com untuk logging terminal dan pencatatan candle 15m ke SQLite (`data/kurs.db`). |
| **Pengecekan ATH** | Pengecekan real-time di memori via WebSocket yang memposting notifikasi saat menembus rekor baru kelipatan Rp 100 (misal: Rp 18.100 $\rightarrow$ Rp 18.200). |
| **Laporan Harian** | Cron otomatis Senin–Sabtu pukul 16:00 WIB yang mengambil data langsung dari Fetch API Investing.com dan memposting ke Misskey. |
| **Grafik Mingguan** | Visualisasi pergerakan kurs 1 minggu terakhir (candle 1 jam `PT1H`) dengan label jam berurutan di atas tanggal pada sumbu X. |
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

#### 1. Testing Lokal (Tanpa Mengirim ke Misskey)
Grafik akan digenerate dan disimpan ke file lokal `test-chart.png`, caption dipratinjau di terminal, dan panggilan API Misskey sepenuhnya dilewati:

```bash
# Test posting harian lokal
pnpm test:local

# Test pengecekan ATH lokal
pnpm test-ath:local
```

#### 2. Testing Pengiriman ke Misskey
Menguji alur penuh termasuk upload gambar dan posting note ke Misskey (default visibility: `specified`):

- **Test Posting Harian**:
  ```bash
  pnpm test
  # atau
  npm run test
  ```

- **Test Pengecekan ATH**:
  ```bash
  pnpm run test-ath
  ```

### Parameter Custom Visibility pada Mode Testing

Secara default, mode testing menggunakan visibilitas `specified` agar pengujian tidak mengotori linimasa publik Misskey. Anda dapat menentukan visibilitas kustom (`public`, `home`, `followers`, `specified`) secara fleksibel:

```bash
pnpm test public
pnpm run test-ath specified
```
---

## 📄 Lisensi

[MIT License](LICENSE.md)
