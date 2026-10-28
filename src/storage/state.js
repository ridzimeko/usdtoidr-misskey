import fs from "node:fs";
import path from "node:path";

const statePath = path.resolve(process.cwd(), "state.json");

export function loadState() {
	if (fs.existsSync(statePath)) {
		try {
			return JSON.parse(fs.readFileSync(statePath, "utf8"));
		} catch (_e) {
			console.error("Gagal mem-parsing state.json, membuat ulang...");
		}
	}
	return {};
}

export function saveState(state) {
	fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function getTimezoneDateInfo(
	date = new Date(),
	timeZone = process.env.CRON_TIMEZONE || "Asia/Jakarta",
) {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "short",
		hour: "numeric",
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const parts = dtf.formatToParts(date);
	const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
	const dateString = `${map.year}-${map.month}-${map.day}`;
	const hour = parseInt(map.hour, 10);
	const weekday = map.weekday;
	const isSunday = weekday === "Sun";
	return { dateString, hour, isSunday, weekday };
}

export function isDailyPostedToday(
	timeZone = process.env.CRON_TIMEZONE || "Asia/Jakarta",
) {
	const state = loadState();
	return (
		state.lastDailySuccessDate ===
		getTimezoneDateInfo(new Date(), timeZone).dateString
	);
}

export function markDailySuccess(dateString) {
	const state = loadState();
	state.lastDailySuccessDate = dateString;
	saveState(state);
}
