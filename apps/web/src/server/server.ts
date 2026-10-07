import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { isApiPath, proxyToApi } from "./apiProxy.js";
import { type AddressConfig, resolveClientAddress } from "./clientAddress.js";

/** adapter-node's documented custom-server entry point, `build/handler.js`. */
export type SvelteKitHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	next: () => void,
) => void;

export interface ServerOptions {
	readonly handler: SvelteKitHandler;
	readonly apiTarget: string;
	readonly address: AddressConfig;
}

/**
 * The API listens on the loopback, addressed as 127.0.0.1 rather than
 * `localhost`, which Node >= 17 resolves to ::1 first.
 */
const DEFAULT_API_TARGET = "http://127.0.0.1:3001";

/** Fail at startup on a malformed API_URL rather than with a 502 on every request. */
export function parseApiTarget(value: string | undefined): string {
	const target = value ?? DEFAULT_API_TARGET;

	if (!URL.canParse(target)) {
		throw new Error(`Invalid API_URL: ${target}`);
	}

	return target;
}

/**
 * The production web server: API paths go straight to the API, everything
 * else to SvelteKit. Requests never cross SvelteKit on the way to the API, so
 * its form CSRF check keeps guarding the app without standing in front of an
 * API that authenticates its own writes.
 */
export function createRequestListener(options: ServerOptions): RequestListener {
	return (req, res) => {
		// Parsed like a browser would, so `/api/../note` is a page, not the API.
		const url = URL.parse(req.url as string, "http://internal");

		if (url && isApiPath(url.pathname)) {
			proxyToApi(req, res, {
				url: `${options.apiTarget}${url.pathname}${url.search}`,
				clientAddress: resolveClientAddress(req, options.address),
			});
			return;
		}

		options.handler(req, res, () => {
			res.statusCode = 404;
			res.end();
		});
	};
}
