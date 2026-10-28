import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

let activeDb = null;
let activeDbPath = null;

export function toNumeric(val) {
	if (val === null || val === undefined || val === "") return null;
	if (typeof val === "number") return Number.isFinite(val) ? val : null;
	const cleaned = String(val).replace(/,/g, "").replace(/%/g, "").trim();
	const parsed = Number(cleaned);
	return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTimestamp(rawTimestamp) {
	let ts = rawTimestamp;
	if (!ts) {
		return Date.now();
	}
	if (typeof ts === "string") {
		const num = Number(ts);
		ts = Number.isFinite(num) ? num : Date.parse(ts) || Date.now();
	}
	// Jika timestamp dalam detik (10 digit), ubah ke milidetik
	if (ts < 1e11) {
		ts = Math.round(ts * 1000);
	}
	return ts;
}

export const CANDLE_INTERVAL_MS = 15 * 60 * 1000;

export function getCandleTimestamp(
	rawTimestamp,
	intervalMs = CANDLE_INTERVAL_MS,
) {
	const ts = normalizeTimestamp(rawTimestamp);
	return Math.floor(ts / intervalMs) * intervalMs;
}

export function getDefaultDbPath() {
	return (
		process.env.SQLITE_DB_PATH || path.resolve(process.cwd(), "data", "kurs.db")
	);
}

export function initDatabase(dbPath = getDefaultDbPath()) {
	if (activeDb && activeDbPath === dbPath) {
		return activeDb;
	}

	if (activeDb) {
		closeDatabase();
	}

	const dir = path.dirname(dbPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const db = new DatabaseSync(dbPath);

	// Optimasi performa SQLite & penanganan akses konkuren
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");
	db.exec("PRAGMA busy_timeout = 5000;");
	// Buat tabel kurs_history
	db.exec(`
		CREATE TABLE IF NOT EXISTS kurs_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp INTEGER NOT NULL,
			price REAL NOT NULL,
			open REAL,
			high REAL,
			low REAL,
			close REAL,
			change REAL,
			change_percent REAL,
			source TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
			UNIQUE(timestamp, source)
		);
		CREATE INDEX IF NOT EXISTS idx_kurs_history_timestamp ON kurs_history(timestamp);
	`);

	activeDb = db;
	activeDbPath = dbPath;
	return activeDb;
}

export function getDb() {
	if (!activeDb) {
		return initDatabase();
	}
	return activeDb;
}

export function closeDatabase() {
	if (activeDb) {
		try {
			activeDb.close();
		} catch (err) {
			console.error("Gagal menutup database SQLite:", err);
		}
		activeDb = null;
		activeDbPath = null;
	}
}

const UPSERT_QUERY = `
	INSERT INTO kurs_history (
		timestamp, price, open, high, low, close, change, change_percent, source
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(timestamp, source) DO UPDATE SET
		price = excluded.price,
		open = coalesce(kurs_history.open, excluded.open),
		high = max(coalesce(kurs_history.high, excluded.high), coalesce(excluded.high, kurs_history.high)),
		low = min(coalesce(kurs_history.low, excluded.low), coalesce(excluded.low, kurs_history.low)),
		close = excluded.close,
		change = coalesce(excluded.change, kurs_history.change),
		change_percent = coalesce(excluded.change_percent, kurs_history.change_percent);
`;

export function saveKursTick(tickData, options = {}) {
	if (!tickData) return null;

	const db = getDb();
	const price =
		toNumeric(tickData.price) ??
		toNumeric(tickData.last_numeric) ??
		toNumeric(tickData.last) ??
		toNumeric(tickData.close);

	if (price === null) {
		console.warn("Tick diabaikan: harga tidak valid", tickData);
		return null;
	}

	// Jika source websocket, rangkum ke bucket candle 15 menit
	const intervalMs = options.intervalMs ?? CANDLE_INTERVAL_MS;
	const timestamp =
		tickData.bucket ??
		(tickData.source === "fetch_api"
			? normalizeTimestamp(tickData.timestamp)
			: getCandleTimestamp(tickData.timestamp, intervalMs));

	const open = toNumeric(tickData.open) ?? price;
	const high = toNumeric(tickData.high) ?? price;
	const low = toNumeric(tickData.low) ?? price;
	const close = toNumeric(tickData.close) ?? price;
	const change = toNumeric(tickData.change) ?? toNumeric(tickData.pc);
	const changePercent =
		toNumeric(tickData.change_percent) ??
		toNumeric(tickData.changePercent) ??
		toNumeric(tickData.pcp);
	const source = tickData.source || "websocket";

	const stmt = db.prepare(UPSERT_QUERY);
	stmt.run(
		timestamp,
		price,
		open,
		high,
		low,
		close,
		change,
		changePercent,
		source,
	);

	return (
		db
			.prepare("SELECT * FROM kurs_history WHERE timestamp = ? AND source = ?")
			.get(timestamp, source) || {
			timestamp,
			price,
			open,
			high,
			low,
			close,
			change,
			change_percent: changePercent,
			source,
		}
	);
}

export function getLatestKursRecord() {
	const db = getDb();
	const stmt = db.prepare(
		"SELECT * FROM kurs_history ORDER BY timestamp DESC LIMIT 1",
	);
	return stmt.get() || null;
}

export function getKursHistory(limit = 160, source = null) {
	const db = getDb();
	const stmt = db.prepare(
		source
			? `
		SELECT * FROM (
			SELECT * FROM kurs_history WHERE source = ? ORDER BY timestamp DESC LIMIT ?
		) ORDER BY timestamp ASC
	`
			: `
		SELECT * FROM (
			SELECT * FROM kurs_history ORDER BY timestamp DESC LIMIT ?
		) ORDER BY timestamp ASC
	`,
	);
	return source ? stmt.all(source, limit) : stmt.all(limit);
}

export function getKursCount() {
	const db = getDb();
	const stmt = db.prepare("SELECT COUNT(*) as count FROM kurs_history");
	const row = stmt.get();
	return row ? row.count : 0;
}
