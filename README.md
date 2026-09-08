# USD to IDR Misskey Bot

Bot otomatis berbasis Node.js yang memantau dan memposting informasi kurs **USD (Dolar AS) ke IDR (Rupiah Indonesia)** beserta grafik pergerakan harga terbaru ke platform **Misskey**.

## 🛠️ Persyaratan Sistem

- **Node.js**: v18+ atau versi lebih baru
- **pnpm**: v10+ (atau npm/yarn)

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
node src/index.js
```

### Mode Testing (CLI)

Untuk melakukan pengujian posting note tanpa menunggu jadwal cron:

- **Test Posting Harian (default visibility: `specified`)**:

  ```bash
  pnpm test
  # atau
  node src/index.js --test
  ```

- **Test Pengecekan ATH (default visibility: `specified`)**:

  ```bash
  pnpm run test-ath
  # atau
  pnpm run test:ath
  # atau
  node src/index.js --test-ath
  ```

### Parameter Custom Visibility pada Mode Testing

Secara default, mode testing menggunakan visibilitas `specified` agar pengujian tidak mengotori linimasa publik Misskey. Anda dapat menentukan visibilitas kustom (`public`, `home`, `followers`, `specified`) secara fleksibel:

- **Test Posting Harian dengan Visibilitas Kustom**:

  ```bash
  # Menggunakan pnpm
  pnpm test public
  pnpm test home

  # Menggunakan node langsung
  node src/index.js --test public
  node src/index.js --test=public
  ```

- **Test Pengecekan ATH dengan Visibilitas Kustom**:

  ```bash
  # Menggunakan pnpm
  pnpm run test-ath public
  pnpm run test-ath specified

  # Menggunakan node langsung
  node src/index.js --test-ath public
  node src/index.js --test-ath=specified
  ```
---

## 📄 Lisensi

[MIT License](LICENSE.md)
