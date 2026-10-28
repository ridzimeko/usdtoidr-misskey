import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { fetch as wreqFetch } from "wreq-js";
import { formatDateTimeWib, formatDateWib, formatIdr } from "../lib/format.js";
import { loadState, saveState } from "../storage/state.js";
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
				browser: "firefox_151",
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
		`Range mingguan: Rp. ${lowStr} - Rp. ${highStr}\n` +
		`ATH tersimpan: Rp. ${athStr}\n\n` +
		`Waktu data: ${dataDateStr} WIB\n` +
		`Sumber: https://investing.com/currencies/usd-idr`;

	return { imageBuffer, caption, closePrice: priceStr };
}

/**
 * Ambil data kurs dan grafik mingguan via Fetch API Investing.com untuk laporan harian
 */
export async function getKursReport(options = { isDaily: true, wsData: null }) {
	const { data } = await getKursData();
	const highestInArray = Math.max(...data.data.map((d) => d[2]));
	const lowestInArray = Math.min(...data.data.map((d) => d[3]));

	const currentPrice = options?.wsData
		? Number(options.wsData.last_numeric ?? parsePrice(options.wsData.last))
		: null;

	const priceToCheck = currentPrice
		? Math.max(
				currentPrice,
				options.wsData?.high ? parsePrice(options.wsData.high) : currentPrice,
			)
		: highestInArray;

	const state = loadState();
	const previousAth = state.ath || priceToCheck;
	const newAth = priceToCheck > previousAth ? priceToCheck : previousAth;
	const isAthCrossed = Math.floor(newAth / 100) > Math.floor(previousAth / 100);

	if (!options?.isDaily && !isAthCrossed) {
		if (newAth > previousAth) {
			state.ath = newAth;
			saveState(state);
		}
		return null;
	}

	const highest = Math.max(highestInArray, priceToCheck);
	const lowest = Math.min(
		lowestInArray,
		options?.wsData?.low ? parsePrice(options.wsData.low) : lowestInArray,
	);

	return await generateKursMessage(
		data,
		isAthCrossed,
		state,
		highest,
		lowest,
		currentPrice,
	);
}
