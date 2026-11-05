/** A bare number is seconds. */
const SECONDS_PER_UNIT = { "": 1, s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 } as const;

const DURATION_RE = /^(\d{1,9})([smhdw]?)$/;

/**
 * Seconds, from `90s`, `30m`, `1h`, `7d`, `2w` or a bare number of seconds;
 * undefined for anything else.
 */
export function parseDuration(value: string): number | undefined {
	const match = DURATION_RE.exec(value);
	if (match === null) {
		return undefined;
	}
	return Number(match[1]) * SECONDS_PER_UNIT[match[2] as keyof typeof SECONDS_PER_UNIT];
}

const SPANS = [
	["d", 86_400],
	["h", 3600],
	["m", 60],
	["s", 1],
] as const;

/** A duration as its two largest units: `1d 1h`, `30m`, `45s`. */
export function formatDuration(seconds: number): string {
	const parts: string[] = [];
	let rest = Math.max(0, Math.floor(seconds));
	for (const [unit, length] of SPANS) {
		const count = Math.floor(rest / length);
		rest -= count * length;
		if (count > 0) {
			parts.push(`${count}${unit}`);
		}
	}
	return parts.length === 0 ? "0s" : parts.slice(0, 2).join(" ");
}

const SIZE_UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;

/** A size in bytes, in binary units: `512 B`, `1.5 KiB`, `42 MiB`. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	let value = bytes;
	let unit: (typeof SIZE_UNITS)[number] = "KiB";
	for (const next of SIZE_UNITS) {
		value /= 1024;
		unit = next;
		if (value < 1024) {
			break;
		}
	}
	return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${unit}`;
}
