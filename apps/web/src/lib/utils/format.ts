const KIB = 1024;
const MIB = 1024 * 1024;

/**
 * A byte count in the reader's language: "2.5 MB", "2,5 Mo", "2,5 МБ".
 * Multiples are binary (1 KB = 1024 bytes), matching the limits the API enforces.
 */
export function formatSize(bytes: number, locale = "en"): string {
	const [value, unit] =
		bytes < KIB
			? [bytes, "byte"]
			: bytes < MIB
				? [bytes / KIB, "kilobyte"]
				: [bytes / MIB, "megabyte"];
	return new Intl.NumberFormat(locale, {
		style: "unit",
		unit,
		unitDisplay: "short",
		maximumFractionDigits: 1,
	}).format(value);
}
