import "dotenv/config";
import cron from "node-cron";
import { postNoteWithMedia, uploadMedia } from "./api.js";
import { initDatabase, saveKursTick } from "./db.js";
import { getKursReport, syncKursWithFetchApi } from "./kurs.js";
import {
	getTimezoneDateInfo,
	isDailyPostedToday,
	loadState,
	markDailySuccess,
	saveState,
} from "./state.js";
import { parsePrice, startKursWebSocketWatcher } from "./websocket.js";

const timezone = process.env.CRON_TIMEZONE || "Asia/Jakarta";

// Setup jadwal (Setiap hari Senin-Sabtu pukul 16:00 WIB)
const dailySchedule = "0 16 * * 1-6";

console.log(`[BOT] Mulai berjalan...`);
console.log(
	`[CRON] Jadwal posting harian diatur: ${dailySchedule} (Zona Waktu: ${timezone})`,
);
console.log("[WS] Pengecekan ATH aktif secara real-time via WebSocket");

export let isDailyTaskRunning = false;
export let dailyRetryTimeout = null;
export let isAthTaskRunning = false;
export let athWatcherStop = null;

export function clearDailyRetryTimeout() {
	clearTimeout(dailyRetryTimeout);
	dailyRetryTimeout = null;
}

/**
 * Core runner untuk memproses siklus fetch data, upload media, dan posting note.
 */
async function processKursTask({
	isDaily,
	visibility,
	taskLabel,
	wsData = null,
}) {
	console.log(
		`\n[${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}] Memulai proses ${taskLabel}...`,
	);
	try {
		console.log("-> Mengambil data kurs terbaru...");
		const report = await getKursReport({ isDaily, wsData });

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
export async function runAthCheckTask(visibility = "public", wsData = null) {
	return await processKursTask({
		isDaily: false,
		visibility,
		taskLabel: "pengecekan ATH",
		wsData,
	});
}

/**
 * Handler untuk pembaruan harga live dari WebSocket
 */
export async function handleLivePriceUpdate(wsData, visibility = "public") {
	if (isAthTaskRunning) {
		return;
	}

	// Simpan data tick harga live ke SQLite
	try {
		saveKursTick({
			timestamp: wsData.timestamp,
			price: wsData.last_numeric ?? wsData.last,
			last: wsData.last,
			last_numeric: wsData.last_numeric,
			high: wsData.high,
			low: wsData.low,
			change: wsData.change ?? wsData.pc,
			changePercent: wsData.changePercent ?? wsData.pcp,
			source: "websocket",
		});
	} catch (err) {
		console.error("Gagal menyimpan tick live ke SQLite:", err);
	}

	const currentPrice = wsData.last_numeric
		? Number(wsData.last_numeric)
		: parsePrice(wsData.last);
	const highPrice = wsData.high ? parsePrice(wsData.high) : currentPrice;
	const priceToCheck = Math.max(currentPrice, highPrice);

	const state = loadState();
	const previousAth = state.ath || priceToCheck;
	const newAth = priceToCheck > previousAth ? priceToCheck : previousAth;
	const isAthCrossed = Math.floor(newAth / 100) > Math.floor(previousAth / 100);

	if (!isAthCrossed) {
		if (newAth > previousAth) {
			state.ath = newAth;
			saveState(state);
		}
		return;
	}

	isAthTaskRunning = true;
	try {
		console.log(
			`\n🚀 [WS] Rekor ATH baru kelipatan 100 terdeteksi: Rp ${priceToCheck} (sebelumnya Rp ${previousAth})! Memproses posting...`,
		);
		await runAthCheckTask(visibility, wsData);
	} catch (err) {
		console.error(
			"❌ Error saat memproses ATH baru dari WebSocket:",
			err.message || err,
		);
	} finally {
		isAthTaskRunning = false;
	}
}

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

export function stopAthWatcher() {
	if (athWatcherStop) {
		athWatcherStop();
		athWatcherStop = null;
	}
}

const VALID_VISIBILITIES = ["public", "home", "followers", "specified"];

export function parseTestVisibility(args, flag) {
	// 1. Cek parameter dalam format flag=value (contoh: --test=public atau --test-ath=specified)
	const eqMatch = args.find((arg) => arg.startsWith(`${flag}=`));
	if (eqMatch) {
		const val = eqMatch.slice(flag.length + 1).trim();
		if (val) return val;
	}

	// 2. Cek parameter tepat setelah flag (contoh: --test public atau --test-ath specified)
	const flagIndex = args.indexOf(flag);
	if (
		flagIndex !== -1 &&
		args[flagIndex + 1] &&
		!args[flagIndex + 1].startsWith("-")
	) {
		return args[flagIndex + 1].trim();
	}

	// 3. Cek flag eksplisit --visibility (contoh: --visibility=public atau --visibility public)
	const visEq = args.find((arg) => arg.startsWith("--visibility="));
	if (visEq) {
		const val = visEq.slice("--visibility=".length).trim();
		if (val) return val;
	}
	const visIndex = args.indexOf("--visibility");
	if (
		visIndex !== -1 &&
		args[visIndex + 1] &&
		!args[visIndex + 1].startsWith("-")
	) {
		return args[visIndex + 1].trim();
	}

	return "specified";
}

/**
 * Task 3: Execution mode testing melalui CLI (--test, --test-ath)
 */
export async function runTestTask() {
	initDatabase();
	const args = process.argv.slice(2);
	const isAthTest = args.some(
		(arg) => arg === "--test-ath" || arg.startsWith("--test-ath="),
	);
	const flag = isAthTest ? "--test-ath" : "--test";
	let visibility = parseTestVisibility(args, flag);

	if (!VALID_VISIBILITIES.includes(visibility)) {
		console.warn(
			`⚠️ Visibility '${visibility}' tidak valid. Menggunakan default 'specified'. (Pilihan: ${VALID_VISIBILITIES.join(", ")})`,
		);
		visibility = "specified";
	}

	if (isAthTest) {
		console.log(
			`[BOT] Mode Testing Aktif! Menjalankan Pengecekan ATH (visibility: ${visibility})`,
		);
		await runAthCheckTask(visibility);
	} else {
		console.log(
			`[BOT] Mode Testing Aktif! Menjalankan Posting Harian (visibility: ${visibility})`,
		);
		await runDailyTask(visibility);
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

const watchdogCron = cron.schedule(
	"0 * * * *",
	() => checkAndRunDailyWatchdog("watchdog-hourly"),
	{ timezone },
);

dailyCron.on("execution:missed", () => checkAndRunDailyWatchdog("cron-missed"));
watchdogCron.on("execution:missed", () =>
	checkAndRunDailyWatchdog("watchdog-missed"),
);

// Inisialisasi Database SQLite
initDatabase();

// Cek apakah mode testing diaktifkan dari CLI
if (process.argv.some((arg) => arg.startsWith("--test"))) {
	runTestTask();
} else {
	// Sinkronisasi riwayat kurs awal saat bot mulai berjalan
	syncKursWithFetchApi().catch((err) => {
		console.error("Gagal melakukan sinkronisasi awal riwayat kurs:", err);
	});

	checkAndRunDailyWatchdog("startup-catchup");
	startAthWatcher("public");
}
