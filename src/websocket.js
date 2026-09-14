import crypto from "node:crypto";
import WebSocket from "ws";
import { saveKursTick } from "./db.js";

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
export function logPriceTick(data) {
	const changeStr =
		data.pc && data.pcp
			? ` (${data.pc} / ${data.pcp})`
			: data.pc
				? ` (${data.pc})`
				: "";
	console.log(
		`[WS] USD/IDR: Rp ${data.last}${changeStr} | Bid: ${data.bid || "-"} | Ask: ${data.ask || "-"} [${data.time || "-"}]`,
	);
}

function connectAndGetPrice(timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const url = generateWebSocketUrl();
		const ws = new WebSocket(url, {
			origin: ORIGIN,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				Pragma: "no-cache",
			},
		});

		let heartbeatTimer = null;
		let timeoutTimer = null;
		let settled = false;

		function cleanup() {
			clearInterval(heartbeatTimer);
			clearTimeout(timeoutTimer);
			heartbeatTimer = null;
			timeoutTimer = null;
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
		}

		timeoutTimer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				new Error(
					`Timeout (${timeoutMs}ms) menunggu data kurs USD/IDR dari WebSocket`,
				),
			);
		}, timeoutMs);

		ws.on("open", () => {
			// Menunggu SockJS frame 'o'
		});

		ws.on("message", (frame) => {
			if (settled) return;
			const raw = frame.toString();

			if (raw === "o") {
				const payload = {
					_event: "bulk-subscribe",
					tzID: 8,
					message: CHANNELS.map((ch) => `${ch}:`).join("%%"),
				};
				ws.send(encodeSockJSMessage(payload));

				heartbeatTimer = setInterval(() => {
					if (ws.readyState === WebSocket.OPEN) {
						ws.send(
							encodeSockJSMessage({
								_event: "heartbeat",
								data: "h",
							}),
						);
					}
				}, 5000);
				return;
			}

			if (raw === "h") {
				return;
			}

			const processMessages = (messages) => {
				for (const msg of messages) {
					const parsed = parseApplicationMessage(msg);
					if (parsed.type === "channel" && parsed.channel === "pid-2138") {
						const data = parsed.data;
						logPriceTick(data);

						settled = true;
						cleanup();
						try {
							saveKursTick({
								timestamp: data.timestamp,
								price: data.last_numeric ?? data.last,
								last: data.last,
								last_numeric: data.last_numeric,
								high: data.high,
								low: data.low,
								change: data.pc,
								changePercent: data.pcp,
								source: "websocket",
							});
						} catch (err) {
							console.error("Gagal menyimpan tick ke SQLite:", err);
						}
						resolve({
							pid: data.pid,
							last: data.last,
							bid: data.bid,
							ask: data.ask,
							change: data.pc,
							changePercent: data.pcp,
							time: data.time,
							last_numeric: data.last_numeric,
							high: data.high,
							low: data.low,
							timestamp: data.timestamp,
							raw: data,
						});
						return true;
					}
				}
				return false;
			};

			if (raw.startsWith("a")) {
				try {
					const messages = JSON.parse(raw.slice(1));
					if (Array.isArray(messages)) {
						processMessages(messages);
					}
				} catch {
					// Abaikan parsing error pada frame SockJS yang tidak valid
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
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		});

		ws.on("close", (code, reason) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				new Error(
					`WebSocket tertutup tidak terduga (code: ${code}, reason: ${reason || "none"})`,
				),
			);
		});
	});
}

export async function fetchKursFromWebSocket({
	timeoutMs = 15000,
	maxRetries = 3,
	retryDelay = 3000,
} = {}) {
	let attempts = 0;
	let lastError = null;

	while (attempts < maxRetries) {
		attempts++;
		try {
			const data = await connectAndGetPrice(timeoutMs);
			return data;
		} catch (err) {
			lastError = err;
			if (attempts < maxRetries) {
				console.warn(
					`⚠️ [WS RETRY ${attempts}/${maxRetries}] Gagal mengambil data WebSocket: ${err.message}. Mencoba lagi dalam ${Math.round(retryDelay / 1000)} detik...`,
				);
				await new Promise((resolve) => setTimeout(resolve, retryDelay));
			}
		}
	}
	console.warn(
		`⚠️ [WS] Gagal mengambil data via WebSocket (setelah ${maxRetries}x percobaan: ${lastError?.message || lastError}). Melakukan fallback & sinkronisasi menggunakan Fetch API...`,
	);
	try {
		const { syncKursWithFetchApi } = await import("./kurs.js");
		const syncResult = await syncKursWithFetchApi();
		const latestPrice = syncResult.latestPrice;
		return {
			pid: "2138",
			last: String(latestPrice),
			last_numeric: latestPrice,
			bid: String(latestPrice),
			ask: String(latestPrice),
			change: "0",
			changePercent: "0%",
			time: new Date(syncResult.timestamp).toTimeString().slice(0, 8),
			high: syncResult.highestInArray,
			low: syncResult.lowestInArray,
			timestamp: syncResult.timestamp,
			raw: syncResult.raw,
			source: "fetch_api_fallback",
		};
	} catch (fallbackErr) {
		console.error(
			"❌ [WS FALLBACK] Gagal sinkronisasi fallback Fetch API:",
			fallbackErr,
		);
		throw new Error(
			`Gagal mengambil data kurs dari WebSocket (${lastError?.message}) dan fallback Fetch API gagal (${fallbackErr.message})`,
		);
	}
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
						logPriceTick(data);

						try {
							saveKursTick({
								timestamp: data.timestamp,
								price: data.last_numeric ?? data.last,
								last: data.last,
								last_numeric: data.last_numeric,
								high: data.high,
								low: data.low,
								change: data.pc,
								changePercent: data.pcp,
								source: "websocket",
							});
						} catch (err) {
							console.error("Gagal menyimpan tick ke SQLite:", err);
						}

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
									high: data.high,
									low: data.low,
									timestamp: data.timestamp,
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
