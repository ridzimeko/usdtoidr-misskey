import 'dotenv/config';
import cron from 'node-cron';
import { uploadMedia, postNoteWithMedia } from './api.js';
import { getKursReport } from './kurs.js';

// Setup jadwal (Setiap hari pukul 08:00 WIB)
const schedule = '0 8 * * *';

console.log(`[BOT] Mulai berjalan...`);
console.log(`[CRON] Jadwal posting otomatis diatur: ${schedule} (Zona Waktu: Asia/Jakarta)`);

async function runTask(visibility) {
    console.log(`\n[${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}] Memulai proses posting otomatis...`);
    try {
        // 1. Ambil data kurs dan gambar
        console.log('  -> Mengambil data kurs terbaru...');
        const { imageBuffer, caption, closePrice } = await getKursReport();
        console.log(`  -> Berhasil! Kurs saat ini: Rp ${closePrice}`);

        // 2. Upload gambar
        console.log('  -> Mengupload gambar ke Misskey...');
        const uploadResult = await uploadMedia(imageBuffer, `kurs-${Date.now()}.png`);

        if (!uploadResult?.id) {
            throw new Error('Gagal mengupload gambar ke drive.');
        }
        console.log(`  -> Gambar berhasil diupload (ID: ${uploadResult.id})`);

        // 3. Post note
        console.log('  -> Memposting note ke timeline...');
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

cron.schedule(schedule, runTask, {
    scheduled: true,
    timezone: "Asia/Jakarta"
});

// test send note
if (process.argv.includes('--test')) {
    console.log("[BOT] Mode Testing Aktif! Pesan dikirim sekarang juga...");
    runTask('public');
}

console.log("[BOT] Menunggu jadwal berikutnya...");
