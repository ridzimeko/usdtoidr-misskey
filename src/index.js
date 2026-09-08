import "dotenv/config";
import cron from "node-cron";
import { postNoteWithMedia, uploadMedia } from "./api.js";
import { getKursReport } from "./kurs.js";
import {
	getTimezoneDateInfo,
	isDailyPostedToday,
	markDailySuccess,
} from "./state.js";

const timezone = process.env.CRON_TIMEZONE || "Asia/Jakarta";

// Setup jadwal (Setiap hari Senin-Sabtu pukul 16:00 WIB)
const dailySchedule = "0 16 * * 1-6";
// Setup jadwal pengecekan ATH (Setiap jam)
const hourlySchedule = "0 * * * *";

console.log(`[BOT] Mulai berjalan...`);
console.log(
	`[CRON] Jadwal posting harian diatur: ${dailySchedule} (Zona Waktu: ${timezone})`,
);
console.log(
	`[CRON] Jadwal pengecekan ATH diatur: ${hourlySchedule} (Zona Waktu: ${timezone})`,
);

export let isDailyTaskRunning = false;
export let dailyRetryTimeout = null;

export function clearDailyRetryTimeout() {
	if (dailyRetryTimeout) {
		clearTimeout(dailyRetryTimeout);
		dailyRetryTimeout = null;
	}
}

/**
 * Core runner untuk memproses siklus fetch data, upload media, dan posting note.
 */
async function processKursTask({ isDaily, visibility, taskLabel }) {
	console.log(
		`\n[${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}] Memulai proses ${taskLabel}...`,
	);
	try {
		console.log("-> Mengambil data kurs terbaru...");
		const report = await getKursReport({ isDaily });

		if (!report) {
			console.log("-> Belum ada rekor ATH baru kelipatan 100. Skip posting.");
			return false;
		}

		const { imageBuffer, caption, closePrice } = report;
		console.log(`-> Berhasil! Kurs saat ini: Rp ${closePrice}`);

		console.log("-> Mengupload gambar ke Misskey...");
		const uploadResult = await uploadMedia(
			imageBuffer,
			`kurs-${Date.now()}.png`,
			`Informasi kurs USD ke IDR hari ini yaitu Rp. ${closePrice} beserta grafik nya`,
		);

		if (!uploadResult?.id) {
			throw new Error("Gagal mengupload gambar ke drive.");
		}
		console.log(`-> Gambar berhasil diupload (ID: ${uploadResult.id})`);

		console.log("-> Memposting note ke timeline...");
		const postResult = await postNoteWithMedia(
			caption,
			uploadResult.id,
			visibility,
		);

		if (postResult) {
			console.log("✅ Selesai! Note berhasil diposting.");
			return true;
		} else {
			console.error("❌ Gagal memposting note.");
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
export async function runDailyTask(visibility = "public") {
	const success = await processKursTask({
		isDaily: true,
		visibility,
		taskLabel: "posting harian",
	});

	if (success && visibility === "public") {
		markDailySuccess(getTimezoneDateInfo(new Date(), timezone).dateString);
	}

	return success;
}

export async function runDailyWithRetry({
	visibility = "public",
	attempt = 1,
	maxRetries = 5,
	retryDelays = [300000, 600000, 900000, 1800000],
} = {}) {
	if (isDailyTaskRunning) {
		console.log(
			"[DAILY] Task posting harian sedang berjalan, lewati trigger baru.",
		);
		return false;
	}

	if (visibility === "public" && isDailyPostedToday(timezone)) {
		console.log(
			"[DAILY] Posting harian sudah berhasil dikirim untuk hari ini. Lewati.",
		);
		return true;
	}

	isDailyTaskRunning = true;
	try {
		const success = await runDailyTask(visibility);

		if (success) {
			if (dailyRetryTimeout) {
				clearTimeout(dailyRetryTimeout);
				dailyRetryTimeout = null;
			}
			console.log("✅ [DAILY] Posting harian berhasil dikirim.");
			return true;
		}

		if (visibility === "public" && attempt <= maxRetries) {
			const delay = retryDelays[attempt - 1] ?? 1800000;
			console.log(
				`⚠️ [RETRY DAILY ${attempt}/${maxRetries}] Posting harian gagal. Mencoba lagi dalam ${Math.round(delay / 60000)} menit...`,
			);
			dailyRetryTimeout = setTimeout(() => {
				dailyRetryTimeout = null;
				runDailyWithRetry({
					visibility,
					attempt: attempt + 1,
					maxRetries,
					retryDelays,
				});
			}, delay);
		} else if (attempt > maxRetries) {
			console.log(
				`❌ [DAILY] Batas maksimal retry (${maxRetries}x) tercapai. Menunggu watchdog jam berikutnya.`,
			);
		}

		return false;
	} finally {
		isDailyTaskRunning = false;
	}
}

export async function checkAndRunDailyWatchdog(reason = "watchdog") {
	const { dateString, hour, isSunday } = getTimezoneDateInfo(
		new Date(),
		timezone,
	);

	if (isSunday) {
		return false;
	}

	if (hour < 16) {
		return false;
	}

	if (isDailyPostedToday(timezone)) {
		return false;
	}

	if (isDailyTaskRunning || dailyRetryTimeout !== null) {
		return false;
	}

	console.log(
		`[${reason.toUpperCase()}] Terdeteksi posting harian hari ini (${dateString}) belum terkirim. Memulai posting harian sekarang...`,
	);
	return await runDailyWithRetry({ visibility: "public" });
}

/**
 * Task 2: Execution pengecekan rekor ATH baru
 */
export async function runAthCheckTask(visibility = "public") {
	return await processKursTask({
		isDaily: false,
		visibility,
		taskLabel: "pengecekan ATH",
	});
}

/**
 * Task 3: Execution mode testing melalui CLI (--test, --test-ath)
 */
export async function runTestTask() {
	const args = process.argv.slice(2);
	const isAthTest = args.includes("--test-ath");

	if (isAthTest) {
		console.log("[BOT] Mode Testing Aktif! Menjalankan Pengecekan ATH");
		await runAthCheckTask("specified");
	} else {
		console.log("[BOT] Mode Testing Aktif! Menjalankan Posting Harian");
		await runDailyTask("specified");
	}

	// keluar jika sudah selesai
	process.exit(0);
}

// Register Cron Schedules
const dailyCron = cron.schedule(
	dailySchedule,
	() => runDailyWithRetry({ visibility: "public" }),
	{
		timezone,
	},
);

const athCron = cron.schedule(
	hourlySchedule,
	async () => {
		await runAthCheckTask("public");
		checkAndRunDailyWatchdog("watchdog-hourly");
	},
	{ timezone },
);

dailyCron.on("execution:missed", () => checkAndRunDailyWatchdog("cron-missed"));
athCron.on("execution:missed", () => runAthCheckTask("public"));

// Cek apakah mode testing diaktifkan dari CLI
if (process.argv.some((arg) => arg.startsWith("--test"))) {
	runTestTask();
} else {
	checkAndRunDailyWatchdog("startup-catchup");
}
console.log("[BOT] Menunggu jadwal berikutnya...");
