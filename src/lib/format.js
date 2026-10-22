const idrFormatter = new Intl.NumberFormat("id-ID", {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

/**
 * Format angka ke representasi Rupiah Indonesia baku (contoh: 17.659,80)
 */
export function formatIdr(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return "0,00";
	return idrFormatter.format(value);
}

function toDate(val) {
	if (val instanceof Date) return val;
	return new Date(val);
}

/**
 * Format waktu ke zona waktu Asia/Jakarta (WIB) dalam format HH:mm (contoh: 19:15)
 */
export function formatTimeWib(val) {
	if (!val) return "-";
	return toDate(val)
		.toLocaleTimeString("id-ID", {
			timeZone: "Asia/Jakarta",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		})
		.replace(/\./g, ":");
}

/**
 * Format tanggal ke zona waktu Asia/Jakarta (WIB) dalam format d MMM (contoh: 14 Sep)
 */
export function formatDateWib(val) {
	if (!val) return "-";
	return toDate(val).toLocaleDateString("id-ID", {
		day: "2-digit",
		month: "short",
		timeZone: "Asia/Jakarta",
	});
}

/**
 * Format tanggal dan jam ke zona waktu Asia/Jakarta (WIB) lengkap
 */
export function formatDateTimeWib(val) {
	if (!val) return "-";
	return toDate(val)
		.toLocaleString("id-ID", {
			day: "2-digit",
			month: "short",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZone: "Asia/Jakarta",
		})
		.replace(/\./g, ":");
}
