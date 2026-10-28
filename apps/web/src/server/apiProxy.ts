import {
	request as httpRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type OutgoingHttpHeaders,
	type ServerResponse,
} from "node:http";
import { pipeline } from "node:stream";

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) describe one connection, not the
 * message: each side of the proxy negotiates its own. Forwarding
 * `transfer-encoding` in particular framed a body that was no longer chunked,
 * and the request failed.
 */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/** Paths the API answers, never SvelteKit. */
export function isApiPath(pathname: string): boolean {
	return (
		pathname === "/api" ||
		pathname.startsWith("/api/") ||
		pathname === "/robots.txt" ||
		pathname === "/sitemap.xml"
	);
}

/** Headers minus the hop-by-hop ones, including any the `Connection` header names. */
export function endToEndHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
	const named = new Set(
		(headers.connection ?? "")
			.split(",")
			.map((name) => name.trim().toLowerCase())
			.filter(Boolean),
	);
	const forwarded: OutgoingHttpHeaders = {};

	for (const [name, value] of Object.entries(headers)) {
		if (HOP_BY_HOP.has(name) || named.has(name)) {
			continue;
		}

		forwarded[name] = value;
	}

	return forwarded;
}

/**
 * The API could not be reached, or the request to it broke.
 *
 * Once the API has started answering, the response pipeline owns `res`: an
 * error on the request side (the API closing the connection after an early
 * 413 while the client is still uploading) must not cut that answer short.
 */
export function handleUpstreamError(res: ServerResponse, error: Error): void {
	if (res.headersSent || res.destroyed) {
		return;
	}

	console.error(
		JSON.stringify({
			time: new Date().toISOString(),
			level: "error",
			msg: "api proxy request failed",
			detail: error.message,
		}),
	);
	res.writeHead(502, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: "Bad Gateway" }));
}

export interface ProxyTarget {
	/** Absolute URL to request from the API. */
	readonly url: string;
	readonly clientAddress: string | undefined;
}

/**
 * Stream a request to the API and its response back, byte for byte.
 *
 * This runs in front of SvelteKit rather than in a hook, for three reasons.
 * The API authenticates every write with headers a cross-site form cannot
 * send, so SvelteKit's form CSRF check has nothing to protect here — it only
 * rejected the SDK's multipart uploads, since a Node client sends no Origin.
 * Bodies stream instead of being buffered whole in memory, up to ~100 MB per
 * upload. And responses are no longer decompressed and re-framed on the way.
 */
export function proxyToApi(req: IncomingMessage, res: ServerResponse, target: ProxyTarget): void {
	const headers = endToEndHeaders(req.headers);

	// The API's peer is always this process, so it tells clients apart by
	// X-Forwarded-For. Forwarding the client's own value would let anyone mint
	// unlimited rate-limit buckets: replace it with the resolved address, or
	// drop it so everyone shares one bucket rather than trusting a value the
	// client chose (the API warns about that degraded mode at startup).
	delete headers["x-forwarded-for"];
	delete headers["x-real-ip"];
	// Addressed to the API, as the fetch-based proxy this replaces did.
	delete headers.host;

	if (target.clientAddress) {
		headers["x-forwarded-for"] = target.clientAddress;
	}

	const upstream = httpRequest(target.url, { method: req.method, headers });

	// A client that leaves before the API answers calls the request off: the
	// answer would have nowhere to go, and the API connection is freed now.
	const callOff = () => upstream.destroy();
	res.once("close", callOff);

	upstream.on("response", (upstreamRes) => {
		// From here on, the response pipeline handles a client that leaves.
		res.off("close", callOff);

		// pipeline() throws on a closed `res` instead of calling back, and
		// thrown from this listener it takes the whole server down. Should an
		// answer still find nobody to take it, drop it with its connection
		// rather than read a body for no one.
		if (res.headersSent || res.destroyed) {
			upstreamRes.destroy();
			return;
		}

		// Answered before the client finished sending (an early 413, a refused
		// write): the rest of its body has nowhere to go, and the connection
		// does not outlive this answer. Saying so keeps the client from sending
		// its next request down it.
		const headers = endToEndHeaders(upstreamRes.headers);
		if (!req.complete) {
			headers.connection = "close";
		}
		// Always set on a response received by an http client.
		res.writeHead(upstreamRes.statusCode as number, headers);
		// A client that disconnects mid-download destroys the upstream response
		// too, which releases the API connection.
		pipeline(upstreamRes, res, () => {});
	});

	upstream.on("error", (error) => handleUpstreamError(res, error));

	// A client that aborts mid-upload destroys the upstream request with it.
	pipeline(req, upstream, () => {});
}
