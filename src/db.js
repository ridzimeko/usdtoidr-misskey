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

export function getDefaultDbPath() {
	return process.env.SQLITE_DB_PATH || path.resolve(process.cwd(), "kurs.db");
}

export function initDatabase(dbPath = getDefaultDbPath()) {
	if (activeDb && activeDbPath === dbPath) {
		return activeDb;
	}

	if (activeDb) {
		closeDatabase();
	}

	const db = new DatabaseSync(dbPath);

	// Optimasi performa SQLite
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");

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
		open = coalesce(excluded.open, kurs_history.open),
		high = coalesce(excluded.high, kurs_history.high),
		low = coalesce(excluded.low, kurs_history.low),
		close = coalesce(excluded.close, kurs_history.close),
		change = coalesce(excluded.change, kurs_history.change),
		change_percent = coalesce(excluded.change_percent, kurs_history.change_percent);
`;

export function saveKursTick(tickData) {
	if (!tickData) return null;

	const db = getDb();
	const timestamp = normalizeTimestamp(tickData.timestamp);
	const price =
		toNumeric(tickData.price) ??
		toNumeric(tickData.last_numeric) ??
		toNumeric(tickData.last) ??
		toNumeric(tickData.close);

	if (price === null) {
		console.warn("Tick diabaikan: harga tidak valid", tickData);
		return null;
	}

	const open = toNumeric(tickData.open);
	const high = toNumeric(tickData.high);
	const low = toNumeric(tickData.low);
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

	return {
		timestamp,
		price,
		open,
		high,
		low,
		close,
		change,
		change_percent: changePercent,
		source,
	};
}

export function saveKursBatch(records) {
	if (!Array.isArray(records) || records.length === 0) {
		return 0;
	}

	const db = getDb();
	const stmt = db.prepare(UPSERT_QUERY);

	db.exec("BEGIN");
	let savedCount = 0;
	try {
		for (const rec of records) {
			const timestamp = normalizeTimestamp(rec.timestamp);
			const price =
				toNumeric(rec.price) ??
				toNumeric(rec.close) ??
				toNumeric(rec.last_numeric) ??
				toNumeric(rec.last);

			if (price === null) continue;

			const open = toNumeric(rec.open);
			const high = toNumeric(rec.high);
			const low = toNumeric(rec.low);
			const close = toNumeric(rec.close) ?? price;
			const change = toNumeric(rec.change) ?? toNumeric(rec.pc);
			const changePercent =
				toNumeric(rec.change_percent) ??
				toNumeric(rec.changePercent) ??
				toNumeric(rec.pcp);
			const source = rec.source || "fetch_api";

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
			savedCount++;
		}
		db.exec("COMMIT");
	} catch (err) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw err;
	}

	return savedCount;
}

export function getLatestKursRecord() {
	const db = getDb();
	const stmt = db.prepare(
		"SELECT * FROM kurs_history ORDER BY timestamp DESC LIMIT 1",
	);
	return stmt.get() || null;
}

export function getKursHistory(limit = 160) {
	const db = getDb();
	const stmt = db.prepare(`
		SELECT * FROM (
			SELECT * FROM kurs_history ORDER BY timestamp DESC LIMIT ?
		) ORDER BY timestamp ASC
	`);
	return stmt.all(limit);
}

export function getKursCount() {
	const db = getDb();
	const stmt = db.prepare("SELECT COUNT(*) as count FROM kurs_history");
	const row = stmt.get();
	return row ? row.count : 0;
}
