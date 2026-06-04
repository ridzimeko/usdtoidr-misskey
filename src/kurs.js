import fs from 'node:fs';
import path from 'node:path';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { createCuimpHttp } from 'cuimp';

const scraper = createCuimpHttp({
    descriptor: { browser: 'chrome', version: 'latest' },
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
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (_e) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    if (!data?.data || data.data.length === 0) {
        throw new Error("Gagal mengambil data dari API");
    }

    return { data };
}

async function generateKursMessage(data) {
    const latest = data.data[data.data.length - 1];
    const unixtime = latest[0];
    const high = latest[2];
    const low = latest[3];
    const close = latest[4];

    const priceStr = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2 }).format(close);
    const highStr = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2 }).format(high);
    const lowStr = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2 }).format(low);

    const chartData = data.data.slice(-20);
    const labels = chartData.map(d => {
        const date = new Date(d[0]);
        const mins = date.getMinutes();
        if (mins === 0 || mins === 30) {
            return `${date.getHours().toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
        }
        return '';
    });
    const closeData = chartData.map(d => d[4]);

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
            ctx.fillText(`${dateStr} WIB · usdtoidr@misskey.id`, 30, 190);
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
                x: { ticks: { color: '#9aa0a6', maxRotation: 0, autoSkip: false }, grid: { display: false }, border: { display: false } },
                y: { position: 'right', ticks: { color: '#9aa0a6', maxTicksLimit: 5 }, grid: { color: '#3c4043', drawBorder: false }, border: { display: false } }
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

    // simpan ATH, closePrice dan high price ke state.json
    const statePath = path.resolve(process.cwd(), 'state.json');
    let state = {};

    if (fs.existsSync(statePath)) {
        try {
            state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        } catch (_e) {
            console.error('Gagal mem-parsing state.json, membuat ulang...');
        }
    }

    state.lastFetchDate = dataDateStr;
    state.ath = state.ath ? (high > state.ath ? high : state.ath) : high;

    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const caption = `*Kurs USD ke IDR*\n\n` +
        `Waktu data: ${dataDateStr} WIB\n` +
        `Kurs saat ini: Rp ${priceStr}\n` +
        `Range hari ini: Rp ${lowStr} - Rp ${highStr}\n` +
        `ATH tersimpan: Rp ${state.ath}\n\n` +
        `Sumber data: https://investing.com/currencies/usd-idr`;

    return { imageBuffer, caption, closePrice: close };
}

export async function getKursReport() {
    const { data } = await getKursData();
    const result = await generateKursMessage(data);
    return result;
}

