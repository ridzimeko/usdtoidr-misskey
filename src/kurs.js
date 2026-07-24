import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { createCuimpHttp } from 'cuimp';
import { loadState, saveState } from './state.js';

const scraper = createCuimpHttp({
    descriptor: { browser: 'chrome', version: 'latest' },
    logger: { debug: () => { } } // nonaktifkan logger binary cuimp
});

const width = 800;
const height = 400;
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });

const url = 'https://api.investing.com/api/financialdata/2138/historical/chart/?interval=PT15M&pointscount=160';

async function getKursData() {
    let data = null;
    let success = false;
    let attempts = 0;
    const maxRetries = 5;
    let lastError = null;

    while (attempts < maxRetries && !success) {
        attempts++;
        try {
            const response = await scraper.get(url);
            let parsed = response.data;
            if (typeof parsed === 'string') {
                parsed = JSON.parse(parsed);
            }

            if (parsed?.data && parsed.data.length > 0) {
                data = parsed;
                success = true;
            } else {
                lastError = new Error("Format respons API tidak sesuai atau data kosong");
                if (attempts < maxRetries) {
                    console.warn(`⚠️ [RETRY ${attempts}/${maxRetries}] Respons API tidak valid/kosong. Mencoba lagi dalam 5 detik...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        } catch (err) {
            lastError = err;
            if (attempts < maxRetries) {
                console.warn(`⚠️ [RETRY ${attempts}/${maxRetries}] Gagal mengambil data: ${err.message}. Mencoba lagi dalam 5 detik...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    if (!data?.data || data.data.length === 0) {
        const errorDetail = lastError?.message ? `: ${lastError.message}` : '';
        throw new Error(`Gagal mengambil data dari API (setelah ${maxRetries}x percobaan)${errorDetail}`);
    }

    return { data };
}

async function generateKursMessage(data, isAthCrossed, state, highestInArray, lowestInArray) {
    const latest = data.data[data.data.length - 1];
    const unixtime = latest[0];
    const close = latest[4];

    const priceStr = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2 }).format(close);
    const highStr = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2 }).format(highestInArray);
    const lowStr = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2 }).format(lowestInArray);
    const athStr = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2 }).format(state.ath);

    const chartData = data.data.slice(-50);
    let lastDateStr = null;
    const labels = chartData.map((d, index) => {
        const date = new Date(d[0]);
        // Tampilkan label setiap 10 data agar tidak penuh
        if (index % 10 === 0) {
            const dateDayStr = date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: 'Asia/Jakarta' });
            const timeStr = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta', hour12: false }).replace(/\./g, ':');

            // Tampilkan tanggal jika label pertama atau ada pergantian hari
            if (lastDateStr === null || dateDayStr !== lastDateStr) {
                lastDateStr = dateDayStr;
                return `${dateDayStr} ${timeStr}`;
            }

            // Jika hari masih sama, tampilkan jam saja
            return timeStr;
        }
        return '';
    });
    const closeData = chartData.map(d => d[4]);

    const minPrice = Math.min(...closeData);
    const maxPrice = Math.max(...closeData);
    let yMin = Math.floor(minPrice / 100) * 100;
    let yMax = Math.ceil(maxPrice / 100) * 100;

    // Pastikan sumbu-Y memiliki minimal 3-4 rentang (4-5 item tick) berjarak 100 Rupiah
    let steps = Math.round((yMax - yMin) / 100);
    const minSteps = 3; // Minimal 3 rentang = 4 item tick pada sumbu Y

    if (steps < minSteps) {
        const needed = minSteps - steps;
        const padBottom = Math.ceil(needed / 2);
        const padTop = Math.floor(needed / 2);

        yMin -= padBottom * 100;
        yMax += padTop * 100;
    }

    const customTextPlugin = {
        id: 'customText',
        beforeDraw: (chart) => {
            const { ctx } = chart;
            ctx.save();
            ctx.fillStyle = '#202124';
            ctx.fillRect(0, 0, chart.width, chart.height);

            ctx.fillStyle = '#9aa0a6';
            ctx.font = '20px sans-serif';
            ctx.fillText('1 Dolar Amerika Serikat sama dengan', 30, 50);

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 54px sans-serif';
            ctx.fillText(priceStr, 30, 115);

            ctx.fillStyle = '#ffffff';
            ctx.font = '36px sans-serif';
            ctx.fillText('Rupiah Indonesia', 30, 160);

            ctx.fillStyle = '#9aa0a6';
            ctx.font = '16px sans-serif';
            const dateStr = new Date(unixtime).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Jakarta' }).replace(/\./g, ':');
            ctx.fillText(`${dateStr} WIB · @usdtoidr@misskey.id`, 30, 190);
            ctx.restore();
        }
    };

    const configuration = {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                data: closeData,
                borderColor: '#8ab4f8',
                borderWidth: 3,
                pointRadius: 0,
                pointHoverRadius: 0,
                tension: 0.1,
                fill: true,
                backgroundColor: 'rgba(138, 180, 248, 0.1)'
            }]
        },
        options: {
            layout: { padding: { top: 220, left: 20, right: 20, bottom: 20 } },
            plugins: { legend: { display: false }, title: { display: false } },
            scales: {
                x: { ticks: { color: '#9aa0a6', maxRotation: 0, autoSkip: false, labelOffset: 25 }, grid: { display: false }, border: { display: false } },
                y: {
                    position: 'right',
                    min: yMin,
                    max: yMax,
                    ticks: {
                        color: '#9aa0a6',
                        stepSize: 100,
                        callback: (value) => new Intl.NumberFormat('id-ID').format(value)
                    },
                    grid: { color: '#3c4043', drawBorder: false },
                    border: { display: false }
                }
            }
        },
        plugins: [customTextPlugin]
    };

    chartJSNodeCanvas.chartCallback = (ChartJS) => {
        ChartJS.defaults.color = '#9aa0a6';
        ChartJS.defaults.font.family = 'sans-serif';
    };

    const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
    const dataDateStr = new Date(unixtime).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    state.lastFetchDate = dataDateStr;
    state.ath = state.ath ? (highestInArray > state.ath ? highestInArray : state.ath) : highestInArray;

    saveState(state);

    const prefix = isAthCrossed ? `🚀 ATH Rupiah Terbaru!\n\n` : ``;

    const caption = `${prefix}Kurs USD ke IDR\n\n` +
        `Kurs saat ini: Rp. ${priceStr}\n` +
        `Range hari ini: Rp. ${lowStr} - Rp. ${highStr}\n` +
        `ATH tersimpan: Rp. ${athStr}\n\n` +
        `Waktu data: ${dataDateStr} WIB\n` +
        `Sumber: https://investing.com/currencies/usd-idr`;

    return { imageBuffer, caption, closePrice: priceStr };
}

export async function getKursReport(options = { isDaily: true }) {
    const { data } = await getKursData();

    // Cari nilai high tertinggi dan low terendah dari seluruh array (160 data poin)
    const highestInArray = Math.max(...data.data.map(d => d[2]));
    const lowestInArray = Math.min(...data.data.map(d => d[3]));

    const state = loadState();

    const previousAth = state.ath || highestInArray;
    const newAth = highestInArray > previousAth ? highestInArray : previousAth;
    const isAthCrossed = Math.floor(newAth / 100) > Math.floor(previousAth / 100);

    if (!options.isDaily && !isAthCrossed) {
        if (newAth > previousAth) {
            state.ath = newAth;
            saveState(state);
        }
        return null;
    }

    const result = await generateKursMessage(data, isAthCrossed, state, highestInArray, lowestInArray);
    return result;
}
