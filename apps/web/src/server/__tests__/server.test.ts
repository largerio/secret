// @vitest-environment node
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	request,
	type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressConfig } from "../clientAddress.js";
import { ORIGIN_HOST_HEADER, ORIGIN_PROTOCOL_HEADER } from "../origin.js";
import { createRequestListener, parseApiTarget, type SvelteKitHandler } from "../server.js";

interface Received {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
	body: string;
}

interface RawResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: Buffer;
}

const GZIP_BYTES = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03]);

let api: Server;
let apiTarget: string;
let received: Received[];
let uploadStarted: Promise<void>;
let reportUploadStarted: () => void;
let abortedUpload: Promise<boolean>;
let reportAbortedUpload: (complete: boolean) => void;

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.closeAllConnections();
		server.close(() => resolve());
	});
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];

	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}

	return Buffer.concat(chunks).toString();
}

/** node:http rather than fetch: no Origin, no decompression, raw bytes back. */
function rawRequest(
	base: string,
	options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const req = request(
			`${base}${options.path}`,
			{ method: options.method ?? "GET", headers: options.headers ?? {} },
			async (res) => {
				const chunks: Buffer[] = [];

				for await (const chunk of res) {
					chunks.push(chunk as Buffer);
				}

				resolve({
					status: res.statusCode as number,
					headers: res.headers,
					body: Buffer.concat(chunks),
				});
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}

const handler = vi.fn<SvelteKitHandler>((_req, res) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end("page");
});

const servers: Server[] = [];

async function startWeb(
	address: AddressConfig = { addressHeader: "", xffDepth: 1 },
	target = apiTarget,
	origin: URL | undefined = undefined,
): Promise<string> {
	const web = createServer(createRequestListener({ handler, apiTarget: target, address, origin }));
	servers.push(web);

	return listen(web);
}

beforeAll(async () => {
	api = createServer(async (req, res) => {
		if (req.url === "/api/v1/notes/upload/slow/complete") {
			req.on("close", () => reportAbortedUpload(req.complete));
			reportUploadStarted();
			return;
		}

		const body = await readBody(req);
		received.push({
			method: req.method as string,
			url: req.url as string,
			headers: req.headers,
			body,
		});

		if (req.url === "/api/compressed") {
			res.writeHead(201, { "content-encoding": "gzip", "x-custom": "kept" });
			res.end(GZIP_BYTES);
			return;
		}

		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "Unauthorized" }));
	});
	apiTarget = await listen(api);
});

afterAll(async () => {
	await close(api);
});

beforeEach(() => {
	received = [];
	handler.mockClear();
	uploadStarted = new Promise((resolve) => {
		reportUploadStarted = resolve;
	});
	abortedUpload = new Promise((resolve) => {
		reportAbortedUpload = resolve;
	});
});

afterEach(async () => {
	await Promise.all(servers.splice(0).map(close));
});

describe("API requests", () => {
	it("reach the API without crossing SvelteKit's form CSRF check", async () => {
		// The SDK's multipart upload from Node: a form content type and no
		// Origin header, which SvelteKit answered with a 403 before the API
		// ever saw it.
		const web = await startWeb();
		const boundary = "----secret";
		const body = `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\nciphertext\r\n--${boundary}--\r\n`;

		const res = await rawRequest(web, {
			method: "POST",
			path: "/api/v1/notes/upload?probe=1",
			headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
			body,
		});

		expect(res.status).toBe(401);
		expect(JSON.parse(res.body.toString())).toEqual({ error: "Unauthorized" });
		expect(handler).not.toHaveBeenCalled();
		expect(received[0]).toMatchObject({
			method: "POST",
			url: "/api/v1/notes/upload?probe=1",
			body,
		});
	});

	it("stream a chunked request body through intact", async () => {
		// Forwarding the incoming `transfer-encoding` alongside a buffered body
		// used to fail the request outright.
		const web = await startWeb();

		const res = await new Promise<number>((resolve, reject) => {
			const req = request(`${web}/api/v1/notes`, { method: "POST" }, (r) => {
				r.resume();
				resolve(r.statusCode as number);
			});
			req.on("error", reject);
			req.write("first,");
			req.end("second");
		});

		expect(res).toBe(401);
		expect(received[0]?.body).toBe("first,second");
	});

	it("come back byte for byte, still compressed", async () => {
		const web = await startWeb();

		const res = await rawRequest(web, { path: "/api/compressed" });

		expect(res.status).toBe(201);
		expect(res.headers["content-encoding"]).toBe("gzip");
		expect(res.headers["x-custom"]).toBe("kept");
		expect(res.body.equals(GZIP_BYTES)).toBe(true);
	});

	it("are addressed to the API host", async () => {
		const web = await startWeb();

		await rawRequest(web, { path: "/api/health", headers: { host: "secret.example" } });

		expect(received[0]?.headers.host).toBe(new URL(apiTarget).host);
	});

	it("replace a client-supplied X-Forwarded-For with the resolved address", async () => {
		const web = await startWeb({ addressHeader: "x-forwarded-for", xffDepth: 1 });

		await rawRequest(web, {
			path: "/api/health",
			headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7", "x-real-ip": "5.6.7.8" },
		});

		expect(received[0]?.headers["x-forwarded-for"]).toBe("203.0.113.7");
		expect(received[0]?.headers["x-real-ip"]).toBeUndefined();
	});

	it("drop X-Forwarded-For when the client address cannot be resolved", async () => {
		const web = await startWeb({ addressHeader: "cf-connecting-ip", xffDepth: 1 });

		await rawRequest(web, { path: "/api/health", headers: { "x-forwarded-for": "6.6.6.6" } });

		expect(received[0]?.headers["x-forwarded-for"]).toBeUndefined();
	});

	it("carry the socket peer by default", async () => {
		const web = await startWeb();

		await rawRequest(web, { path: "/api/health", headers: { "x-forwarded-for": "6.6.6.6" } });

		expect(received[0]?.headers["x-forwarded-for"]).toMatch(/127\.0\.0\.1$/);
	});

	it("are cut off at the API when the client aborts mid-upload", async () => {
		const web = await startWeb();
		const req = request(`${web}/api/v1/notes/upload/slow/complete`, {
			method: "POST",
			headers: { "content-length": "1000" },
		});
		req.on("error", () => {});
		req.write("partial");

		await uploadStarted;
		req.destroy();

		expect(await abortedUpload).toBe(false);
	});

	it("answer 502 when the API is unreachable", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const web = await startWeb(undefined, "http://127.0.0.1:1");

		const res = await rawRequest(web, { path: "/api/health" });

		expect(res.status).toBe(502);
		expect(JSON.parse(res.body.toString())).toEqual({ error: "Bad Gateway" });
		log.mockRestore();
	});
});

describe("page requests", () => {
	it("go to SvelteKit", async () => {
		const web = await startWeb();

		const res = await rawRequest(web, { path: "/note/abc" });

		expect(res.body.toString()).toBe("page");
		expect(received).toHaveLength(0);
	});

	it("carry the configured origin to SvelteKit, whatever the client claimed", async () => {
		const web = await startWeb(undefined, apiTarget, new URL("http://nas.local:3000"));

		await rawRequest(web, {
			path: "/",
			headers: { [ORIGIN_PROTOCOL_HEADER]: "https", [ORIGIN_HOST_HEADER]: "evil.example" },
		});

		const [req] = handler.mock.calls[0] ?? [];
		expect(req?.headers[ORIGIN_PROTOCOL_HEADER]).toBe("http");
		expect(req?.headers[ORIGIN_HOST_HEADER]).toBe("nas.local:3000");
	});

	it("leave the origin to adapter-node when none is configured", async () => {
		const web = await startWeb();

		await rawRequest(web, { path: "/" });

		const [req] = handler.mock.calls[0] ?? [];
		expect(req?.headers[ORIGIN_HOST_HEADER]).toBeUndefined();
	});

	it("are resolved like a browser would before routing", async () => {
		const web = await startWeb();

		await rawRequest(web, { path: "/api/../note/abc" });

		expect(handler).toHaveBeenCalledTimes(1);
		expect(received).toHaveLength(0);
	});

	it("go to SvelteKit when the target cannot be parsed", async () => {
		const web = await startWeb();

		await rawRequest(web, { path: "//[" });

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("answer 404 when SvelteKit passes them on", async () => {
		handler.mockImplementationOnce((_req, _res, next) => next());
		const web = await startWeb();

		const res = await rawRequest(web, { path: "/missing" });

		expect(res.status).toBe(404);
	});
});

describe("parseApiTarget", () => {
	it("defaults to the API on the loopback", () => {
		expect(parseApiTarget(undefined)).toBe("http://127.0.0.1:3001");
	});

	it("accepts a valid URL", () => {
		expect(parseApiTarget("http://api:4000")).toBe("http://api:4000");
	});

	it("refuses a malformed one at startup", () => {
		expect(() => parseApiTarget("not a url")).toThrow("Invalid API_URL: not a url");
	});
});
