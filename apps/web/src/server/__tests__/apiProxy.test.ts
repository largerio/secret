// @vitest-environment node
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { endToEndHeaders, handleUpstreamError, isApiPath } from "../apiProxy.js";

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

	it("answers 502 with a JSON error and logs the cause", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = fakeResponse();

		handleUpstreamError(res as unknown as ServerResponse, new Error("connect ECONNREFUSED"));

		expect(res.writeHead).toHaveBeenCalledWith(502, { "content-type": "application/json" });
		expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Bad Gateway" }));
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
