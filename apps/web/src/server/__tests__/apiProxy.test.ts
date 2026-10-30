// @vitest-environment node
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { endToEndHeaders, handleUpstreamError, isApiPath, proxyToApi } from "../apiProxy.js";

describe("isApiPath", () => {
	it.each(["/api", "/api/health", "/api/v1/notes/abc", "/robots.txt", "/sitemap.xml"])(
		"routes %s to the API",
		(pathname) => {
			expect(isApiPath(pathname)).toBe(true);
		},
	);

	it.each(["/", "/note/abc", "/apidocs", "/robots.txt.bak", "/_app/version.json"])(
		"leaves %s to SvelteKit",
		(pathname) => {
			expect(isApiPath(pathname)).toBe(false);
		},
	);
});

describe("endToEndHeaders", () => {
	it("drops hop-by-hop headers and keeps the rest", () => {
		expect(
			endToEndHeaders({
				connection: "keep-alive",
				"keep-alive": "timeout=5",
				"transfer-encoding": "chunked",
				te: "trailers",
				upgrade: "h2c",
				"content-type": "application/json",
				"set-cookie": ["a=1", "b=2"],
			}),
		).toEqual({ "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
	});

	it("also drops the headers the Connection header names", () => {
		expect(endToEndHeaders({ connection: "close, X-Hop", "x-hop": "1", "x-end": "2" })).toEqual({
			"x-end": "2",
		});
	});

	it("keeps everything when there is no Connection header", () => {
		expect(endToEndHeaders({ "x-end": "2" })).toEqual({ "x-end": "2" });
	});
});

describe("handleUpstreamError", () => {
	function fakeResponse(state: { headersSent?: boolean; destroyed?: boolean } = {}) {
		return {
			headersSent: state.headersSent ?? false,
			destroyed: state.destroyed ?? false,
			writeHead: vi.fn(),
			end: vi.fn(),
		};
	}

	it("answers 502 with problem details and logs the cause", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = fakeResponse();

		handleUpstreamError(res as unknown as ServerResponse, new Error("connect ECONNREFUSED"));

		expect(res.writeHead).toHaveBeenCalledWith(502, { "content-type": "application/problem+json" });
		expect(JSON.parse(res.end.mock.calls[0]?.[0] as string)).toEqual({
			type: "about:blank",
			title: "Bad Gateway",
			status: 502,
			code: "bad_gateway",
			detail: "Bad Gateway",
			error: "Bad Gateway",
		});
		expect(log.mock.calls[0]?.[0]).toContain("connect ECONNREFUSED");
		log.mockRestore();
	});

	it("leaves an answer the API already started alone", () => {
		// The API can answer early (a 413 while the client is still uploading)
		// and close the connection: the request side then fails, but the
		// response is already on its way and must reach the client whole.
		const res = fakeResponse({ headersSent: true });

		handleUpstreamError(res as unknown as ServerResponse, new Error("write EPIPE"));

		expect(res.writeHead).not.toHaveBeenCalled();
		expect(res.end).not.toHaveBeenCalled();
	});

	it("does nothing once the client is gone", () => {
		const res = fakeResponse({ destroyed: true });

		handleUpstreamError(res as unknown as ServerResponse, new Error("aborted"));

		expect(res.writeHead).not.toHaveBeenCalled();
	});
});

describe("proxyToApi", () => {
	it("drops an answer that finds the response already closed", async () => {
		// The request to the API is called off as the client leaves, which a
		// response closed before the proxy even started never signals. Piping
		// into it would throw instead of calling back, and crash the server.
		let apiConnectionClosed: () => void = () => {};
		const closed = new Promise<void>((resolve) => {
			apiConnectionClosed = resolve;
		});
		const api = createServer((req, res) => {
			req.socket.on("close", apiConnectionClosed);
			res.end("late");
		});
		api.listen(0, "127.0.0.1");
		await once(api, "listening");
		const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}/`;
		const req = Object.assign(Readable.from([]), { method: "GET", headers: {} });
		const res = Object.assign(new Writable(), { headersSent: false, writeHead: vi.fn() });
		res.destroy();
		await once(res, "close");

		proxyToApi(req as unknown as IncomingMessage, res as unknown as ServerResponse, {
			url,
			clientAddress: undefined,
		});

		await closed;
		expect(res.writeHead).not.toHaveBeenCalled();
		api.close();
	});
});
