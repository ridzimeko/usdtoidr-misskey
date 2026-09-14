import "dotenv/config";
import cron from "node-cron";
import { isTestMode, runTestTask } from "./cli.js";
import { initDatabase } from "./db.js";
import { syncKursWithFetchApi } from "./kurs.js";
import {
	checkAndRunDailyWatchdog,
	handleLivePriceUpdate,
	runDailyWithRetry,
} from "./tasks.js";
import { startKursWebSocketWatcher } from "./websocket.js";

const timezone = process.env.CRON_TIMEZONE || "Asia/Jakarta";
const dailySchedule = "0 16 * * 1-6"; // Setiap hari Senin-Sabtu pukul 16:00 WIB

export let athWatcherStop = null;

/**
 * Memulai watcher WebSocket untuk mendeteksi rekor ATH
 */
export function startAthWatcher(visibility = "public") {
	if (athWatcherStop) {
		return athWatcherStop;
	}

	athWatcherStop = startKursWebSocketWatcher({
		onPrice: (wsData) => handleLivePriceUpdate(wsData, visibility),
		onDisconnect: (reason) => {
			console.warn(
				`⚠️ [WS DISCONNECT] Koneksi WebSocket terputus (${reason}). Menyinkronkan riwayat kurs via Fetch API...`,
			);
			syncKursWithFetchApi().catch((err) => {
				console.error(
					"Gagal menyinkronkan riwayat kurs via Fetch API saat disconnect:",
					err,
				);
			});
		},
		onReconnect: () => {
			console.log(
				"🔄 [WS RECONNECT] Terhubung kembali ke WebSocket! Menyinkronkan data yang terlewat via Fetch API...",
			);
			syncKursWithFetchApi().catch((err) => {
				console.error(
					"Gagal menyinkronkan riwayat kurs via Fetch API saat reconnect:",
					err,
				);
			});
		},
		onError: (err) => {
			console.error("[WS] WebSocket error:", err.message || err);
		},
	});

	return athWatcherStop;
}

/**
 * Menghentikan watcher WebSocket
 */
export function stopAthWatcher() {
	if (athWatcherStop) {
		athWatcherStop();
		athWatcherStop = null;
	}
}

/**
 * Mendaftarkan jadwal cron harian dan watchdog
 */
export function registerCronSchedules() {
	const dailyCron = cron.schedule(
		dailySchedule,
		() => runDailyWithRetry({ visibility: "public", timezone }),
		{ timezone },
	);

	const watchdogCron = cron.schedule(
		"0 * * * *",
		() => checkAndRunDailyWatchdog("watchdog-hourly", timezone),
		{ timezone },
	);

	dailyCron.on("execution:missed", () =>
		checkAndRunDailyWatchdog("cron-missed", timezone),
	);
	watchdogCron.on("execution:missed", () =>
		checkAndRunDailyWatchdog("watchdog-missed", timezone),
	);

	return { dailyCron, watchdogCron };
}

/**
 * Inisialisasi dan jalankan daemon bot utama
 */
export async function startDaemon() {
	console.log("[BOT] Mulai berjalan...");
	console.log(
		`[CRON] Jadwal posting harian diatur: ${dailySchedule} (Zona Waktu: ${timezone})`,
	);
	console.log("[WS] Pengecekan ATH aktif secara real-time via WebSocket");

	// Inisialisasi Database SQLite
	initDatabase();

	// Registrasi Cron Schedules
	registerCronSchedules();

	// Sinkronisasi riwayat kurs awal saat bot mulai berjalan
	syncKursWithFetchApi().catch((err) => {
		console.error("Gagal melakukan sinkronisasi awal riwayat kurs:", err);
	});

	// Pemeriksaan jika ada postingan hari ini yang terlewat
	checkAndRunDailyWatchdog("startup-catchup", timezone);

	// Jalankan watcher WebSocket
	startAthWatcher("public");

	console.log("[BOT] Menunggu jadwal berikutnya...");
}

// Cek apakah mode testing diaktifkan dari CLI
if (isTestMode()) {
	runTestTask();
} else {
	startDaemon();
}
