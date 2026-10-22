import crypto from "node:crypto";
import WebSocket from "ws";
import { formatIdr, formatTimeWib } from "../lib/format.js";
import {
	CANDLE_INTERVAL_MS,
	getCandleTimestamp,
	saveKursTick,
} from "../storage/db.js";

const BASE_WS = "wss://streaming.forexpros.com/echo";
const ORIGIN = "https://www.investing.com";
const CHANNELS = ["pid-2138", "pidExt-2138", "isOpenExch-2"];

export function generateServerId() {
	return String(Math.floor(Math.random() * 1000)).padStart(3, "0");
}

export function generateSessionId(length = 8) {
	const chars = "abcdefghijklmnopqrstuvwxyz012345";
	const bytes = crypto.randomBytes(length);
	let result = "";
	for (let i = 0; i < length; i++) {
		result += chars[bytes[i] % chars.length];
	}
	return result;
}

export function generateWebSocketUrl() {
	const serverId = generateServerId();
	const sessionId = generateSessionId();
	return `${BASE_WS}/${serverId}/${sessionId}/websocket`;
}

export function encodeSockJSMessage(payload) {
	return JSON.stringify([JSON.stringify(payload)]);
}

export function parseApplicationMessage(raw) {
	let envelope;
	try {
		envelope = JSON.parse(raw);
	} catch {
		return { type: "unknown", raw };
	}

	if (!envelope.message) {
		return { type: "event", data: envelope };
	}

	const separatorIndex = envelope.message.indexOf("::");
	if (separatorIndex === -1) {
		return { type: "message", data: envelope.message };
	}

	const channel = envelope.message.slice(0, separatorIndex);
	const payloadRaw = envelope.message.slice(separatorIndex + 2);
	let data;
	try {
		data = JSON.parse(payloadRaw);
	} catch {
		data = payloadRaw;
	}

	return { type: "channel", channel, data };
}

export function parsePrice(val) {
	if (typeof val === "number") return val;
	if (!val) return 0;
	return parseFloat(String(val).replace(/,/g, ""));
}
export function logCandleClosed(candle) {
	const startStr = formatTimeWib(candle.bucket);
	const endStr = formatTimeWib(candle.bucket + CANDLE_INTERVAL_MS);
	const changeVal = candle.close - candle.open;
	const changeStr =
		candle.change != null
			? String(candle.change).startsWith("+") ||
				String(candle.change).startsWith("-")
				? String(candle.change)
				: `+${candle.change}`
			: `${changeVal >= 0 ? "+" : ""}${changeVal.toFixed(1)}`;
	const changePctStr =
		candle.changePercent != null
			? String(candle.changePercent)
			: `${((changeVal / candle.open) * 100).toFixed(2)}%`;

	console.log(
		`[WS CANDLE 15M] ${startStr} - ${endStr} WIB | Open: ${formatIdr(candle.open)} | High: ${formatIdr(candle.high)} | Low: ${formatIdr(candle.low)} | Close: ${formatIdr(candle.close)} (${changeStr} / ${changePctStr}) | Ticks: ${candle.tickCount}`,
	);
}

export function logCandleActive(candle) {
	const startStr = formatTimeWib(candle.bucket);
	const endStr = formatTimeWib(candle.bucket + CANDLE_INTERVAL_MS);
	console.log(
		`[WS 15M] Candle aktif: ${startStr} - ${endStr} WIB (Open: Rp ${formatIdr(candle.open)})`,
	);
}

export function startKursWebSocketWatcher({
	onPrice,
	onError,
	onDisconnect,
	onReconnect,
	reconnectDelay = 2000,
	stalledTimeoutMs = 30000,
	autoSyncOnDisconnect = true,
} = {}) {
	let ws = null;
	let heartbeatTimer = null;
	let reconnectTimer = null;
	let watchdogTimer = null;
	let isStopped = false;
	let isConnected = false;
	let hasEverConnected = false;
	let lastMessageTime = Date.now();
	let activeCandle = null;
	function stopHeartbeat() {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}

	function startHeartbeat() {
		stopHeartbeat();
		heartbeatTimer = setInterval(() => {
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(
					encodeSockJSMessage({
						_event: "heartbeat",
						data: "h",
					}),
				);
			}
		}, 5000);
	}

	function stopWatchdog() {
		clearInterval(watchdogTimer);
		watchdogTimer = null;
	}

	function startWatchdog() {
		stopWatchdog();
		watchdogTimer = setInterval(() => {
			// Cek apakah candle 15 menit sudah selesai dan perlu dicetak
			if (
				activeCandle &&
				Date.now() >= activeCandle.bucket + CANDLE_INTERVAL_MS
			) {
				logCandleClosed(activeCandle);
				activeCandle = null;
			}

			if (ws && ws.readyState === WebSocket.OPEN) {
				const idleMs = Date.now() - lastMessageTime;
				if (idleMs > stalledTimeoutMs) {
					console.warn(
						`⚠️ [WS WATCHDOG] Tidak ada pesan selama ${Math.round(idleMs / 1000)} detik (koneksi zombie/stalled). Menutup koneksi paksa...`,
					);
					try {
						ws.close();
					} catch (e) {
						console.error("Gagal menutup ws stalled:", e);
					}
				}
			}
		}, 5000);
	}

	async function triggerSync(reason) {
		try {
			const { syncKursWithFetchApi } = await import("./kurs.js");
			await syncKursWithFetchApi();
		} catch (err) {
			console.error(
				`❌ [WS] Gagal auto-sync Fetch API pada event ${reason}:`,
				err.message || err,
			);
		}
	}

	function handleDisconnect(reason) {
		if (isConnected) {
			isConnected = false;
			console.warn(
				`⚠️ [WS] Koneksi WebSocket terputus (${reason})! Menyinkronkan riwayat kurs menggunakan Fetch API...`,
			);
			if (onDisconnect) {
				try {
					onDisconnect(reason);
				} catch (err) {
					console.error("Error pada callback onDisconnect:", err);
				}
			}
			if (autoSyncOnDisconnect) {
				triggerSync("disconnect");
			}
		}
	}

	function reconnect() {
		if (isStopped || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, reconnectDelay);
	}

	function connect() {
		if (isStopped) return;

		const url = generateWebSocketUrl();
		ws = new WebSocket(url, {
			origin: ORIGIN,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				Pragma: "no-cache",
			},
		});

		ws.on("open", () => {
			// Menunggu SockJS frame 'o'
		});

		ws.on("message", (frame) => {
			lastMessageTime = Date.now();
			const raw = frame.toString();

			if (raw === "o") {
				const payload = {
					_event: "bulk-subscribe",
					tzID: 8,
					message: CHANNELS.map((ch) => `${ch}:`).join("%%"),
				};
				ws.send(encodeSockJSMessage(payload));
				startHeartbeat();
				startWatchdog();

				if (!isConnected) {
					if (hasEverConnected) {
						console.log(
							"🔄 [WS] Terhubung kembali ke WebSocket! Menyinkronkan data yang terlewat via Fetch API...",
						);
						if (onReconnect) {
							try {
								onReconnect();
							} catch (err) {
								console.error("Error pada callback onReconnect:", err);
							}
						}
						if (autoSyncOnDisconnect) {
							triggerSync("reconnect");
						}
					}
					isConnected = true;
					hasEverConnected = true;
				}
				return;
			}

			if (raw === "h") {
				return;
			}

			if (raw.startsWith("c")) {
				return;
			}

			const processMessages = (messages) => {
				for (const msg of messages) {
					const parsed = parseApplicationMessage(msg);
					if (parsed.type === "channel" && parsed.channel === "pid-2138") {
						const data = parsed.data;
						const currentPrice = data.last_numeric
							? Number(data.last_numeric)
							: parsePrice(data.last);
						const tickTimestamp = data.timestamp
							? Number(data.timestamp) *
								(Number(data.timestamp) < 1e11 ? 1000 : 1)
							: Date.now();
						const currentBucket = getCandleTimestamp(
							tickTimestamp,
							CANDLE_INTERVAL_MS,
						);

						// 1. Cek rollover candle 15 menit
						if (activeCandle && currentBucket > activeCandle.bucket) {
							logCandleClosed(activeCandle);
							activeCandle = null;
						}

						if (!activeCandle) {
							activeCandle = {
								bucket: currentBucket,
								open: currentPrice,
								high: data.high
									? Math.max(parsePrice(data.high), currentPrice)
									: currentPrice,
								low: data.low
									? Math.min(parsePrice(data.low), currentPrice)
									: currentPrice,
								close: currentPrice,
								change: data.pc,
								changePercent: data.pcp,
								tickCount: 1,
							};
							logCandleActive(activeCandle);
						} else {
							activeCandle.high = Math.max(activeCandle.high, currentPrice);
							if (data.high) {
								activeCandle.high = Math.max(
									activeCandle.high,
									parsePrice(data.high),
								);
							}
							activeCandle.low = Math.min(activeCandle.low, currentPrice);
							if (data.low) {
								activeCandle.low = Math.min(
									activeCandle.low,
									parsePrice(data.low),
								);
							}
							activeCandle.close = currentPrice;
							activeCandle.change = data.pc;
							activeCandle.changePercent = data.pcp;
							activeCandle.tickCount++;
						}

						// 2. Simpan atau perbarui candle 15 menit di SQLite
						try {
							saveKursTick({
								bucket: currentBucket,
								timestamp: tickTimestamp,
								price: currentPrice,
								last: data.last,
								last_numeric: data.last_numeric,
								high: activeCandle.high,
								low: activeCandle.low,
								close: currentPrice,
								change: data.pc,
								changePercent: data.pcp,
								source: "websocket",
							});
						} catch (err) {
							console.error("Gagal menyimpan candle ke SQLite:", err);
						}

						// 3. Callback onPrice (deteksi ATH tetap instan per tick)
						if (onPrice) {
							try {
								onPrice({
									pid: data.pid,
									last: data.last,
									bid: data.bid,
									ask: data.ask,
									change: data.pc,
									changePercent: data.pcp,
									time: data.time,
									last_numeric: data.last_numeric,
									high: activeCandle.high,
									low: activeCandle.low,
									timestamp: tickTimestamp,
									raw: data,
								});
							} catch (err) {
								console.error("Error pada callback onPrice:", err);
							}
						}
					}
				}
			};

			if (raw.startsWith("a")) {
				try {
					const messages = JSON.parse(raw.slice(1));
					if (Array.isArray(messages)) {
						processMessages(messages);
					}
				} catch {
					// Abaikan parsing error
				}
				return;
			}

			if (raw.startsWith("m")) {
				try {
					const message = JSON.parse(raw.slice(1));
					processMessages([message]);
				} catch {
					// Abaikan parsing error
				}
			}
		});

		ws.on("error", (err) => {
			handleDisconnect(`error: ${err.message || err}`);
			if (onError) onError(err);
		});

		ws.on("close", (code, reason) => {
			stopHeartbeat();
			stopWatchdog();
			handleDisconnect(`closed code: ${code}, reason: ${reason || "none"}`);
			reconnect();
		});
	}

	connect();

	return function stop() {
		isStopped = true;
		stopHeartbeat();
		stopWatchdog();
		clearTimeout(reconnectTimer);
		if (ws) {
			ws.removeAllListeners();
			ws.on("error", () => {});
			if (
				ws.readyState === WebSocket.OPEN ||
				ws.readyState === WebSocket.CONNECTING
			) {
				try {
					ws.close();
				} catch {}
			}
		}
	};
}
