import fs from "node:fs";
import { postNoteWithMedia, uploadMedia } from "./lib/misskey.js";
import { getKursReport } from "./services/kurs.js";
import { parsePrice } from "./services/websocket.js";
import {
	getTimezoneDateInfo,
	isDailyPostedToday,
	loadState,
	markDailySuccess,
	saveState,
} from "./storage/state.js";

const DEFAULT_TIMEZONE = process.env.CRON_TIMEZONE || "Asia/Jakarta";

export let isDailyTaskRunning = false;
export let dailyRetryTimeout = null;
export let isAthTaskRunning = false;

export function clearDailyRetryTimeout() {
	if (dailyRetryTimeout) {
		clearTimeout(dailyRetryTimeout);
		dailyRetryTimeout = null;
	}
}

/**
 * Core runner untuk memproses siklus fetch data, upload media, dan posting note.
 */
export async function processKursTask({
	isDaily = true,
	visibility,
	taskLabel = "posting harian",
	wsData = null,
	dryRun = false,
}) {
	console.log(
		`\n[${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}] Memulai proses ${taskLabel}...`,
	);
	try {
		console.log("-> Mengambil data kurs terbaru via Fetch API...");
		const report = await getKursReport({ isDaily, wsData });

		if (!report) {
			console.log("-> Belum ada rekor ATH baru kelipatan 100. Skip posting.");
			return false;
		}

		const { imageBuffer, caption, closePrice } = report;
		console.log(`-> Berhasil! Kurs saat ini: Rp ${closePrice}`);

		if (dryRun) {
			fs.writeFileSync("test-chart.png", imageBuffer);
			console.log(
				`-> [LOCAL] Gambar grafik berhasil dibuat dan disimpan ke test-chart.png (${imageBuffer.length} bytes)`,
			);
			console.log(
				"-> [LOCAL] Mode test lokal aktif: melewati upload dan posting ke Misskey.",
			);
			console.log(`-> [LOCAL] Pratinjau caption:\n---\n${caption}\n---`);
			return true;
		}

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
		}

		console.error("❌ Gagal memposting note.");
		return false;
	} catch (error) {
		console.error(`❌ Error pada ${taskLabel}:`, error.message || error);
		return false;
	}
}

/**
 * Task 1: Execution posting harian kurs USD -> IDR
 */
export async function runDailyTask(
	visibility = "public",
	timezone = DEFAULT_TIMEZONE,
	options = {},
) {
	const dryRun = Boolean(options.dryRun || options.local);
	const success = await processKursTask({
		visibility,
		taskLabel: "posting harian",
		dryRun,
	});

	if (success && visibility === "public" && !dryRun) {
		markDailySuccess(getTimezoneDateInfo(new Date(), timezone).dateString);
	}

	return success;
}

export async function runDailyWithRetry({
	visibility = "public",
	attempt = 1,
	maxRetries = 5,
	retryDelays = [300000, 600000, 900000, 1800000],
	timezone = DEFAULT_TIMEZONE,
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
		const success = await runDailyTask(visibility, timezone);

		if (success) {
			clearDailyRetryTimeout();
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
					timezone,
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

export async function checkAndRunDailyWatchdog(
	reason = "watchdog",
	timezone = DEFAULT_TIMEZONE,
) {
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
	return await runDailyWithRetry({ visibility: "public", timezone });
}

/**
 * Task 2: Execution pengecekan rekor ATH baru
 */
export async function runAthCheckTask(
	visibility = "public",
	wsData = null,
	options = {},
) {
	const dryRun = Boolean(options.dryRun || options.local);
	return await processKursTask({
		isDaily: false,
		visibility,
		taskLabel: "pengecekan ATH",
		wsData,
		dryRun,
	});
}

/**
 * Handler untuk pembaruan harga live dari WebSocket (deteksi ATH)
 */
export async function handleLivePriceUpdate(wsData, visibility = "public") {
	if (isAthTaskRunning) {
		return;
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
