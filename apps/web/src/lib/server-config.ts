import type { ServerConfig } from "@largerio/secret-shared";
import {
	DEFAULT_CHUNK_SIZE,
	DEFAULT_MAX_CHUNKED_SIZE,
	EXPIRATION_OPTIONS,
	MAX_EXPIRY_SECONDS,
	MAX_FILE_SIZE,
	MAX_FILES_PER_NOTE,
} from "@largerio/secret-shared";

/**
 * Read a positive numeric setting, falling back on anything unusable.
 *
 * `Number(env)` alone returns NaN for "20MB" and 0 for "", and both flow
 * straight into the UI: a NaN limit makes `file.size > limit` always false, so
 * size validation silently stops happening, and a 0 limit rejects every file.
 */
export function readPositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;

	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

	return Math.floor(parsed);
}

/**
 * Build the config handed to the browser, from the process environment.
 *
 * Kept pure and separate from the route loader so the parsing rules are
 * testable without a SvelteKit harness.
 */
export function buildServerConfig(
	env: Record<string, string | undefined>,
	origin: string,
): ServerConfig {
	const appUrl = env["APP_URL"] ?? origin;

	return {
		appName: env["APP_NAME"] ?? "Secret",
		appDescription: env["APP_DESCRIPTION"] ?? "Zero-knowledge encrypted sharing",
		appUrl,
		primaryColor: env["APP_PRIMARY_COLOR"] ?? "#6366f1",
		footerText: env["APP_FOOTER_TEXT"] ?? "",
		ogImageUrl: env["APP_OG_IMAGE_URL"] || `${appUrl}/og.png`,
		maxFileSize: readPositiveInt(env["MAX_FILE_SIZE"], MAX_FILE_SIZE),
		maxFilesPerNote: readPositiveInt(env["MAX_FILES_PER_NOTE"], MAX_FILES_PER_NOTE),
		chunkSize: readPositiveInt(env["CHUNK_SIZE"], DEFAULT_CHUNK_SIZE),
		maxChunkedFileSize: readPositiveInt(env["MAX_CHUNKED_FILE_SIZE"], DEFAULT_MAX_CHUNKED_SIZE),
		maxExpiry: readPositiveInt(env["MAX_EXPIRY"], MAX_EXPIRY_SECONDS),
	};
}

/**
 * The expiration choices this instance will actually accept.
 *
 * The API enforces MAX_EXPIRY per request, but the picker used to list every
 * option regardless — so an operator tightening retention to 7 days left a
 * "30 days" entry in the UI that failed with a raw 400 on submit. Never returns
 * an empty list: if the ceiling is below even the shortest option, offering the
 * shortest one and letting the server reject it beats a picker with no choices.
 */
export function allowedExpirationOptions(
	maxExpiry: number,
): ReadonlyArray<(typeof EXPIRATION_OPTIONS)[number]> {
	const allowed = EXPIRATION_OPTIONS.filter((option) => option.value <= maxExpiry);
	return allowed.length > 0 ? allowed : [EXPIRATION_OPTIONS[0]];
}

/**
 * Pick a default expiry that the instance accepts: the configured default when
 * it fits, otherwise the longest option that does.
 */
export function defaultExpiration(maxExpiry: number): number {
	const allowed = allowedExpirationOptions(maxExpiry);
	const preferred = allowed.find((option) => option.value === 86_400);
	if (preferred) return preferred.value;

	// allowedExpirationOptions never returns an empty list, so this is safe and
	// needs no fallback branch.
	return Math.max(...allowed.map((option) => option.value));
}
