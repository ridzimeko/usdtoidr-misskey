import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { fetch as wreqFetch } from "wreq-js";
import { formatDateTimeWib, formatDateWib, formatIdr } from "../lib/format.js";
import {
	getKursHistory,
	getLatestKursRecord,
	saveKursBatch,
	saveKursTick,
} from "../storage/db.js";
import {
	getLastSyncTime,
	loadState,
	saveLastSyncTime,
	saveState,
} from "../storage/state.js";
import { parsePrice } from "./websocket.js";

const width = 800;
const height = 400;
const chartJSNodeCanvas = new ChartJSNodeCanvas({
	width,
	height,
	backgroundColour: "white",
});

const url =
	"https://api.investing.com/api/financialdata/2138/historical/chart/?interval=PT1H&pointscount=160";

export async function getKursData() {
	let data = null;
	let success = false;
	let attempts = 0;
	const maxRetries = 3;
	let lastError = null;

	while (attempts < maxRetries && !success) {
		attempts++;
		try {
			const response = await wreqFetch(url, {
				browser: "chrome_149",
			});
			if (!response.ok) {
				throw new Error(`HTTP error ${response.status}`);
			}
			const parsed = await response.json();

			if (parsed?.data && parsed.data.length > 0) {
				data = parsed;
				success = true;
			} else {
				lastError = new Error(
					"Format respons API tidak sesuai atau data kosong",
				);
				if (attempts < maxRetries) {
					console.warn(
						`⚠️ [RETRY ${attempts}/${maxRetries}] Respons API tidak valid/kosong. Mencoba lagi dalam 5 detik...`,
					);
					await new Promise((resolve) => setTimeout(resolve, 5000));
				}
			}
		} catch (err) {
			lastError = err;
			if (attempts < maxRetries) {
				console.warn(
					`⚠️ [RETRY ${attempts}/${maxRetries}] Gagal mengambil data: ${err.message}. Mencoba lagi dalam 5 detik...`,
				);
				await new Promise((resolve) => setTimeout(resolve, 5000));
			}
		}
	}

	if (!data?.data || data.data.length === 0) {
		const errorDetail = lastError?.message ? `: ${lastError.message}` : "";
		throw new Error(
			`Gagal mengambil data dari API (setelah ${maxRetries}x percobaan)${errorDetail}`,
		);
	}

	return { data };
}

async function generateKursMessage(
	data,
	isAthCrossed,
	state,
	highestInArray,
	lowestInArray,
	latestPrice = null,
) {
	const latest = data.data[data.data.length - 1];
	const unixtime = latest[0];
	const close = latestPrice ?? latest[4];

	const priceStr = formatIdr(close);
	const highStr = formatIdr(highestInArray);
	const lowStr = formatIdr(lowestInArray);
	const athStr = formatIdr(state.ath);

	const oneWeekAgo = unixtime - 7 * 24 * 60 * 60 * 1000;
	const filtered = data.data.filter((d) => d[0] >= oneWeekAgo);
	const chartData = filtered.length >= 10 ? filtered : data.data;

	// Bagi label secara merata (maksimal 6 titik label sepanjang 1 minggu)
	const numLabels = Math.min(6, chartData.length);
	const labelIndices = new Set();
	for (let i = 0; i < numLabels; i++) {
		const idx = Math.round((i * (chartData.length - 1)) / (numLabels - 1));
		labelIndices.add(idx);
	}

	const labels = chartData.map((d, index) => {
		if (labelIndices.has(index)) {
			return formatDateWib(d[0]);
		}
		return "";
	});
	const closeData = chartData.map((d) => d[4]);

	const minPrice = Math.min(...closeData);
	const maxPrice = Math.max(...closeData);
	const Y_STEP = 50;
	let yMin = Math.floor(minPrice / Y_STEP) * Y_STEP;
	let yMax = Math.ceil(maxPrice / Y_STEP) * Y_STEP;

	// Pastikan sumbu-Y memiliki minimal 3 rentang (4 item tick) berjarak 50 Rupiah
	const steps = Math.round((yMax - yMin) / Y_STEP);
	const minSteps = 3; // Minimal 3 rentang = 4 item tick pada sumbu Y

	if (steps < minSteps) {
		const needed = minSteps - steps;
		const padBottom = Math.ceil(needed / 2);
		const padTop = Math.floor(needed / 2);

		yMin -= padBottom * Y_STEP;
		yMax += padTop * Y_STEP;
	}

	const customTextPlugin = {
		id: "customText",
		beforeDraw: (chart) => {
			const { ctx } = chart;
			ctx.save();
			ctx.fillStyle = "#202124";
			ctx.fillRect(0, 0, chart.width, chart.height);

			ctx.fillStyle = "#9aa0a6";
			ctx.font = "20px sans-serif";
			ctx.fillText("1 Dolar Amerika Serikat sama dengan", 30, 50);

			ctx.fillStyle = "#ffffff";
			ctx.font = "bold 54px sans-serif";
			ctx.fillText(priceStr, 30, 115);

			ctx.fillStyle = "#ffffff";
			ctx.font = "36px sans-serif";
			ctx.fillText("Rupiah Indonesia", 30, 160);

			ctx.fillStyle = "#9aa0a6";
			ctx.font = "16px sans-serif";
			const dateStr = formatDateTimeWib(unixtime);
			ctx.fillText(`${dateStr} WIB · @usdtoidr@misskey.id`, 30, 190);
			ctx.restore();
		},
	};

	const configuration = {
		type: "line",
		data: {
			labels: labels,
			datasets: [
				{
					data: closeData,
					borderColor: "#8ab4f8",
					borderWidth: 3,
					pointRadius: 0,
					pointHoverRadius: 0,
					tension: 0.1,
					fill: true,
					backgroundColor: "rgba(138, 180, 248, 0.1)",
				},
			],
		},
		options: {
			layout: { padding: { top: 220, left: 20, right: 20, bottom: 20 } },
			plugins: { legend: { display: false }, title: { display: false } },
			scales: {
				x: {
					ticks: {
						color: "#9aa0a6",
						maxRotation: 0,
						autoSkip: false,
					},
					grid: { display: false },
					border: { display: false },
				},
				y: {
					position: "right",
					min: yMin,
					max: yMax,
					ticks: {
						color: "#9aa0a6",
						stepSize: Y_STEP,
						callback: (value) => new Intl.NumberFormat("id-ID").format(value),
					},
					grid: { color: "#3c4043", drawBorder: false },
					border: { display: false },
				},
			},
		},
		plugins: [customTextPlugin],
	};

	chartJSNodeCanvas.chartCallback = (ChartJS) => {
		ChartJS.defaults.color = "#9aa0a6";
		ChartJS.defaults.font.family = "sans-serif";
	};

	const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
	const dataDateStr = new Date(unixtime).toLocaleString("id-ID", {
		timeZone: "Asia/Jakarta",
	});

	state.lastFetchDate = dataDateStr;
	state.ath = state.ath
		? highestInArray > state.ath
			? highestInArray
			: state.ath
		: highestInArray;

	saveState(state);

	const prefix = isAthCrossed ? `🚀 ATH Rupiah Terbaru!\n\n` : ``;

	const caption =
		`${prefix}Kurs USD ke IDR\n\n` +
		`Kurs saat ini: Rp. ${priceStr}\n` +
		`Range hari ini: Rp. ${lowStr} - Rp. ${highStr}\n` +
		`ATH tersimpan: Rp. ${athStr}\n\n` +
		`Waktu data: ${dataDateStr} WIB\n` +
		`Sumber: https://investing.com/currencies/usd-idr`;

	return { imageBuffer, caption, closePrice: priceStr };
}

export const DEFAULT_SYNC_OFFSET_MS = 15 * 60 * 1000; // 10 menit

let lastSyncResult = null;
let activeSyncPromise = null;

export async function syncKursWithFetchApi({
	offsetMs = DEFAULT_SYNC_OFFSET_MS,
	force = false,
} = {}) {
	const now = Date.now();
	const lastSyncTime = getLastSyncTime();
	const timeSinceLastSync = now - lastSyncTime;

	// Lewati jika baru saja disinkronkan kurang dari jeda offset 10 menit
	if (!force && lastSyncTime > 0 && timeSinceLastSync < offsetMs) {
		const remainingSec = Math.round((offsetMs - timeSinceLastSync) / 1000);
		console.log(
			`ℹ️ [SYNC] Sinkronisasi Fetch API dilewati: sinkronisasi terakhir ${Math.round(timeSinceLastSync / 1000)}s lalu (offset jeda 10 menit, sisa ${remainingSec}s).`,
		);
		if (!lastSyncResult) {
			const latest = getLatestKursRecord();
			if (latest) {
				lastSyncResult = {
					syncedCount: 0,
					latestPrice: latest.price,
					highestInArray: latest.high,
					lowestInArray: latest.low,
					timestamp: latest.timestamp,
					raw: null,
				};
			}
		}
		return lastSyncResult;
	}

	if (activeSyncPromise) {
		console.log(
			"ℹ️ [SYNC] Sinkronisasi Fetch API sedang berjalan, menunggu proses yang ada...",
		);
		return activeSyncPromise;
	}
	activeSyncPromise = (async () => {
		try {
			console.log(
				"🔄 [SYNC] Memulai sinkronisasi riwayat kurs via Fetch API (Investing.com)...",
			);
			const { data } = await getKursData();
			if (!data?.data || !Array.isArray(data.data) || data.data.length === 0) {
				throw new Error(
					"Data chart dari Investing.com kosong atau format tidak sesuai",
				);
			}

			// Format data: [timestamp, open, high, low, close, volume]
			const records = data.data.map((point) => ({
				timestamp: point[0],
				open: point[1],
				high: point[2],
				low: point[3],
				close: point[4],
				price: point[4],
				source: "fetch_api",
			}));

			const syncedCount = saveKursBatch(records, { replaceSource: true });
			console.log(
				`✅ [SYNC] Berhasil menyinkronkan ${syncedCount} titik kurs ke SQLite.`,
			);

			const latestPoint = data.data[data.data.length - 1];
			const latestPrice = latestPoint ? latestPoint[4] : null;
			const highestInArray = Math.max(...data.data.map((d) => d[2]));
			const lowestInArray = Math.min(...data.data.map((d) => d[3]));

			// Cek dan sinkronkan rekor ATH jika ada nilai lebih tinggi
			const state = loadState();
			const previousAth = state.ath || highestInArray;
			if (highestInArray > previousAth) {
				state.ath = highestInArray;
				saveState(state);
				console.log(
					`📈 [SYNC] Rekor ATH baru diperbarui di state: Rp ${highestInArray}`,
				);
			}

			saveLastSyncTime(Date.now());
			lastSyncResult = {
				syncedCount,
				latestPrice,
				highestInArray,
				lowestInArray,
				timestamp: latestPoint ? latestPoint[0] : Date.now(),
				raw: data,
			};

			return lastSyncResult;
		} finally {
			activeSyncPromise = null;
		}
	})();

	return activeSyncPromise;
}

/**
 * Ambil titik data chart murni dari database SQLite
 */
export function getChartDataFromDatabase(limit = 160) {
	let history = getKursHistory(limit, "fetch_api");
	if (history.length === 0) {
		history = getKursHistory(limit);
	}
	if (history.length === 0) {
		throw new Error(
			"Data riwayat kurs di SQLite kosong. Pastikan bot sudah tersinkronisasi saat startup.",
		);
	}

	const points = history.map((h) => [
		h.timestamp,
		h.open ?? h.price,
		h.high ?? h.price,
		h.low ?? h.price,
		h.close ?? h.price,
		0,
		0,
	]);
	const highestInArray = Math.max(...points.map((d) => d[2]));
	const lowestInArray = Math.min(...points.map((d) => d[3]));

	return {
		data: { data: points },
		highestInArray,
		lowestInArray,
	};
}

export async function getKursReport(options = { isDaily: true, wsData: null }) {
	if (options.isDaily) {
		const { data, highestInArray, lowestInArray } =
			getChartDataFromDatabase(160);

		const state = loadState();

		const previousAth = state.ath || highestInArray;
		const newAth = highestInArray > previousAth ? highestInArray : previousAth;
		const isAthCrossed =
			Math.floor(newAth / 100) > Math.floor(previousAth / 100);

		const result = await generateKursMessage(
			data,
			isAthCrossed,
			state,
			highestInArray,
			lowestInArray,
		);
		return result;
	}

	// Pengecekan ATH
	let wsData = options.wsData;
	if (!wsData) {
		const latest = getLatestKursRecord();
		if (!latest) {
			throw new Error(
				"Data kurs di SQLite kosong. Pastikan bot sudah tersinkronisasi saat startup.",
			);
		}
		wsData = {
			timestamp: latest.timestamp,
			last: latest.price,
			last_numeric: latest.price,
			high: latest.high,
			low: latest.low,
			source: latest.source,
		};
	} else {
		// Simpan data tick ke SQLite jika dipassing dari watcher live
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
			console.error("Gagal menyimpan tick WebSocket ke SQLite:", err);
		}
	}

	const currentPrice = wsData.last_numeric
		? Number(wsData.last_numeric)
		: parsePrice(wsData.last);
	const highPrice = wsData.high ? parsePrice(wsData.high) : currentPrice;
	const lowPrice = wsData.low ? parsePrice(wsData.low) : currentPrice;
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
		return null;
	}

	// Jika rekor ATH baru kelipatan 100 terlewati, ambil data chart untuk posting gambar
	const {
		data,
		highestInArray: highestFromChart,
		lowestInArray: lowestFromChart,
	} = getChartDataFromDatabase(160);
	const highestInArray = Math.max(highestFromChart, priceToCheck);
	const lowestInArray = Math.min(lowestFromChart, lowPrice);
	const result = await generateKursMessage(
		data,
		isAthCrossed,
		state,
		highestInArray,
		lowestInArray,
		currentPrice,
	);
	return result;
}
