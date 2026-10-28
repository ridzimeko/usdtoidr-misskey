import { runAthCheckTask, runDailyTask } from "./tasks.js";

export const VALID_VISIBILITIES = ["public", "home", "followers", "specified"];

export function parseTestVisibility(args, flag) {
	// 1. Cek parameter dalam format flag=value (contoh: --test=public atau --test-ath=specified)
	const eqMatch = args.find((arg) => arg.startsWith(`${flag}=`));
	if (eqMatch) {
		const val = eqMatch.slice(flag.length + 1).trim();
		if (val) return val;
	}

	// 2. Cek parameter tepat setelah flag (contoh: --test public atau --test-ath specified)
	const flagIndex = args.indexOf(flag);
	if (
		flagIndex !== -1 &&
		args[flagIndex + 1] &&
		!args[flagIndex + 1].startsWith("-")
	) {
		return args[flagIndex + 1].trim();
	}

	// 3. Cek flag eksplisit --visibility (contoh: --visibility=public atau --visibility public)
	const visEq = args.find((arg) => arg.startsWith("--visibility="));
	if (visEq) {
		const val = visEq.slice("--visibility=".length).trim();
		if (val) return val;
	}
	const visIndex = args.indexOf("--visibility");
	if (
		visIndex !== -1 &&
		args[visIndex + 1] &&
		!args[visIndex + 1].startsWith("-")
	) {
		return args[visIndex + 1].trim();
	}

	return "specified";
}

export function isTestMode(args = process.argv.slice(2)) {
	return args.some(
		(arg) =>
			arg.startsWith("--test") || arg === "--local" || arg === "--dry-run",
	);
}

/**
 * Eksekusi mode testing melalui CLI (--test, --test-ath)
 */
export async function runTestTask({
	args = process.argv.slice(2),
	exitOnDone = true,
} = {}) {
	const isLocal = args.some(
		(arg) => arg === "--local" || arg === "--test-local" || arg === "--dry-run",
	);
	const isAthTest = args.some(
		(arg) => arg === "--test-ath" || arg.startsWith("--test-ath="),
	);
	const flag = isAthTest ? "--test-ath" : "--test";
	let visibility = parseTestVisibility(args, flag);

	if (!VALID_VISIBILITIES.includes(visibility)) {
		console.warn(
			`⚠️ Visibility '${visibility}' tidak valid. Menggunakan default 'specified'. (Pilihan: ${VALID_VISIBILITIES.join(", ")})`,
		);
		visibility = "specified";
	}

	if (isAthTest) {
		console.log(
			`[BOT] Mode Testing ${isLocal ? "Lokal " : ""}Aktif! Menjalankan Pengecekan ATH${isLocal ? " (tanpa kirim ke Misskey)" : ` (visibility: ${visibility})`}`,
		);
		await runAthCheckTask(visibility, null, { dryRun: isLocal });
	} else {
		console.log(
			`[BOT] Mode Testing ${isLocal ? "Lokal " : ""}Aktif! Menjalankan Posting Harian${isLocal ? " (tanpa kirim ke Misskey)" : ` (visibility: ${visibility})`}`,
		);
		await runDailyTask(visibility, undefined, { dryRun: isLocal });
	}

	if (exitOnDone) {
		process.exit(0);
	}
}
