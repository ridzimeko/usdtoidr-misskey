import 'dotenv/config';
import cron from 'node-cron';
import { uploadMedia, postNoteWithMedia } from './api.js';
import { getKursReport } from './kurs.js';

// Setup jadwal (Setiap hari Senin-Sabtu pukul 16:00 WIB)
const dailySchedule = '0 16 * * 1-6';
// Setup jadwal pengecekan ATH (Setiap jam)
const hourlySchedule = '0 * * * *';

console.log(`[BOT] Mulai berjalan...`);
console.log(`[CRON] Jadwal posting harian diatur: ${dailySchedule} (Zona Waktu: Asia/Jakarta)`);
console.log(`[CRON] Jadwal pengecekan ATH diatur: ${hourlySchedule} (Zona Waktu: Asia/Jakarta)`);

/**
 * Core runner untuk memproses siklus fetch data, upload media, dan posting note.
 */
async function processKursTask({ isDaily, visibility, taskLabel }) {
    console.log(`\n[${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}] Memulai proses ${taskLabel}...`);
    try {
        console.log('-> Mengambil data kurs terbaru...');
        const report = await getKursReport({ isDaily });

        if (!report) {
            console.log('-> Belum ada rekor ATH baru kelipatan 100. Skip posting.');
            return false;
        }

        const { imageBuffer, caption, closePrice } = report;
        console.log(`-> Berhasil! Kurs saat ini: Rp ${closePrice}`);

        console.log('-> Mengupload gambar ke Misskey...');
        const uploadResult = await uploadMedia(
            imageBuffer,
            `kurs-${Date.now()}.png`,
            `Informasi kurs USD ke IDR hari ini yaitu Rp. ${closePrice} beserta grafik nya`
        );

        if (!uploadResult?.id) {
            throw new Error('Gagal mengupload gambar ke drive.');
        }
        console.log(`-> Gambar berhasil diupload (ID: ${uploadResult.id})`);

        console.log('-> Memposting note ke timeline...');
        const postResult = await postNoteWithMedia(caption, uploadResult.id, visibility);

        if (postResult) {
            console.log('✅ Selesai! Note berhasil diposting.');
            return true;
        } else {
            console.error('❌ Gagal memposting note.');
            return false;
        }

    } catch (error) {
        console.error(`❌ Error pada ${taskLabel}:`, error.message || error);
        return false;
    }
}

/**
 * Task 1: Execution posting harian kurs USD -> IDR
 */
export async function runDailyTask(visibility = 'public') {
    return await processKursTask({
        isDaily: true,
        visibility,
        taskLabel: 'posting harian'
    });
}

/**
 * Task 2: Execution pengecekan rekor ATH baru
 */
export async function runAthCheckTask(visibility = 'public') {
    return await processKursTask({
        isDaily: false,
        visibility,
        taskLabel: 'pengecekan ATH'
    });
}

/**
 * Task 3: Execution mode testing melalui CLI (--test, --test-ath)
 */
export async function runTestTask() {
    const args = process.argv.slice(2);
    const isAthTest = args.includes('--test-ath');

    if (isAthTest) {
        console.log("[BOT] Mode Testing Aktif! Menjalankan Pengecekan ATH");
        await runAthCheckTask('specified');
    } else {
        console.log("[BOT] Mode Testing Aktif! Menjalankan Posting Harian");
        await runDailyTask('specified');
    }

    // keluar jika sudah selesai
    process.exit(0);
}

const timezone = process.env.CRON_TIMEZONE || 'Asia/Jakarta';

// Register Cron Schedules
cron.schedule(dailySchedule, () => runDailyTask('public'), {
    scheduled: true,
    timezone
});

cron.schedule(hourlySchedule, () => runAthCheckTask('public'), {
    scheduled: true,
    timezone
});

// Cek apakah mode testing diaktifkan dari CLI
if (process.argv.some(arg => arg.startsWith('--test'))) {
    runTestTask();
}

console.log("[BOT] Menunggu jadwal berikutnya...");
