import { posix } from "node:path";
import { UsageError } from "./errors.js";

const DURATION_UNITS: Readonly<Record<string, number>> = {
	s: 1,
	m: 60,
	h: 3_600,
	d: 86_400,
};

/**
 * Parse an expiry such as `30m`, `2h`, `7d` or a bare number of seconds.
 * The range itself is not checked here: the instance enforces it and its
 * error message is relayed as-is.
 */
export function parseDuration(input: string): number {
	const trimmed = input.trim();
	const multiplier = DURATION_UNITS[trimmed.slice(-1).toLowerCase()];
	const digits = multiplier === undefined ? trimmed : trimmed.slice(0, -1);
	if (!/^\d+$/.test(digits)) {
		throw new UsageError(
			`Invalid duration '${input}': use seconds, or a number followed by s, m, h or d (e.g. 30m, 2h, 7d)`,
		);
	}
	return Number(digits) * (multiplier ?? 1);
}

/** Parse `--reads`: a non-negative integer, 0 meaning unlimited. */
export function parseReads(input: string): number {
	if (!/^\d+$/.test(input.trim())) {
		throw new UsageError(`Invalid read count '${input}': use a whole number (0 = unlimited)`);
	}
	return Number(input.trim());
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${String(bytes)} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	html: "text/html",
	json: "application/json",
	xml: "application/xml",
	pdf: "application/pdf",
	zip: "application/zip",
	gz: "application/gzip",
	tar: "application/x-tar",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	webm: "video/webm",
};

/**
 * Best-effort content type from the extension. It only drives the preview in
 * the web UI, so an unknown extension is simply an opaque download.
 */
export function mimeType(filename: string): string {
	const dot = filename.lastIndexOf(".");
	const ext = dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
	return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * A file name from a note is attacker-controlled: whoever created the note
 * chose it. Keep only the last path segment so `../../.ssh/authorized_keys`
 * lands in the output directory as `authorized_keys`.
 */
export function safeFilename(name: string): string {
	const base = posix.basename(name.replaceAll("\\", "/"));
	return base === "" || base === "." || base === ".." ? "file" : base;
}
