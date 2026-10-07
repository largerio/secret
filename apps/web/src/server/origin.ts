import type { IncomingMessage } from "node:http";

/**
 * adapter-node 6 dropped ORIGIN. The origin is now either fixed at build time
 * (`paths.origin`, useless for an image built once for every instance) or
 * derived per request from Host and PROTOCOL_HEADER, defaulting to https. On
 * plain HTTP that default is wrong, and SvelteKit's CSRF check then rejects
 * the app's own form submissions.
 *
 * These private headers carry the configured origin instead: the server sets
 * them on every page request, overwriting anything a client sent, and points
 * adapter-node at them. API requests never reach SvelteKit, so they need none.
 */
export const ORIGIN_PROTOCOL_HEADER = "x-secret-origin-protocol";
export const ORIGIN_HOST_HEADER = "x-secret-origin-host";

/** Fail at startup on a malformed ORIGIN (APP_URL in the image). */
export function parseOrigin(value: string | undefined): URL | undefined {
	if (!value) {
		return undefined;
	}

	const url = URL.parse(value);

	if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
		throw new Error(`Invalid ORIGIN: ${value} (expected an http:// or https:// URL)`);
	}

	return url;
}

/**
 * What adapter-node must read before it loads, so its per-request origin is
 * built from our headers alone. The host carries any port, hence no
 * PORT_HEADER.
 */
export const ORIGIN_ADAPTER_ENV: Readonly<Record<string, string>> = {
	PROTOCOL_HEADER: ORIGIN_PROTOCOL_HEADER,
	HOST_HEADER: ORIGIN_HOST_HEADER,
	PORT_HEADER: "",
};

export function applyOrigin(req: IncomingMessage, origin: URL): void {
	req.headers[ORIGIN_PROTOCOL_HEADER] = origin.protocol.slice(0, -1);
	req.headers[ORIGIN_HOST_HEADER] = origin.host;
}
