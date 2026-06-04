import 'dotenv/config';
import cron from 'node-cron';
import { uploadMedia, postNoteWithMedia } from './api.js';
import { getKursReport } from './kurs.js';

// Setup jadwal (Setiap hari pukul 08:00 WIB)
const dailySchedule = '0 8 * * *';
// Setup jadwal pengecekan ATH (Setiap jam)
const hourlySchedule = '0 * * * *';

console.log(`[BOT] Mulai berjalan...`);
console.log(`[CRON] Jadwal posting harian diatur: ${dailySchedule} (Zona Waktu: Asia/Jakarta)`);
console.log(`[CRON] Jadwal pengecekan ATH diatur: ${hourlySchedule} (Zona Waktu: Asia/Jakarta)`);

async function runTask(visibility, isDaily = true) {
    console.log(`\n[${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}] Memulai proses ${isDaily ? 'posting otomatis' : 'pengecekan ATH'}...`);
    try {
        // 1. Ambil data kurs dan gambar
        console.log('-> Mengambil data kurs terbaru...');
        const report = await getKursReport({ isDaily });

        if (!report) {
            console.log('-> Belum ada rekor ATH baru kelipatan 100. Skip posting.');
            return;
        }

        const { imageBuffer, caption, closePrice } = report;
        console.log(`-> Berhasil! Kurs saat ini: Rp ${closePrice}`);

        // 2. Upload gambar
        console.log('-> Mengupload gambar ke Misskey...');
        const uploadResult = await uploadMedia(imageBuffer, `kurs-${Date.now()}.png`, `Informasi kurs USD ke IDR hari ini yaitu Rp. ${closePrice} beserta grafik nya`);

        if (!uploadResult?.id) {
            throw new Error('Gagal mengupload gambar ke drive.');
        }
        console.log(`-> Gambar berhasil diupload (ID: ${uploadResult.id})`);

        // 3. Post note
        console.log('-> Memposting note ke timeline...');
        const postResult = await postNoteWithMedia(caption, uploadResult.id, visibility);

        if (postResult) {
            console.log('✅ Selesai! Note berhasil diposting.');
        } else {
            console.error('❌ Gagal memposting note.');
        }

    } catch (error) {
        console.error(error.message || error);
    }
}

cron.schedule(dailySchedule, () => runTask('public', true), {
    scheduled: true,
    timezone: "Asia/Jakarta"
});

cron.schedule(hourlySchedule, () => runTask('public', false), {
    scheduled: true,
    timezone: "Asia/Jakarta"
});

// test send note
if (process.argv.includes('--test')) {
    console.log("[BOT] Mode Testing Aktif! Pengecekan ATH dikirim sekarang juga...");
    runTask('specified', true);
    process.exit(0);
}

console.log("[BOT] Menunggu jadwal berikutnya...");
