import { env } from "$env/dynamic/private";

const DEFAULT_API_TARGET = "http://localhost:3001";

const rawApiUrl = env["API_URL"];

// Fail fast on an explicitly-set but malformed API_URL so misconfiguration
// surfaces at startup rather than as opaque proxy failures at request time.
if (rawApiUrl !== undefined) {
	try {
		new URL(rawApiUrl);
	} catch {
		throw new Error(`Invalid API_URL: ${rawApiUrl}`);
	}
}

export const API_TARGET = rawApiUrl ?? DEFAULT_API_TARGET;
