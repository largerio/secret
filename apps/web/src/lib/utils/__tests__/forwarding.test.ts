import { describe, expect, it, vi } from "vitest";
import { forwardingFetch, readClientAddress } from "../forwarding.js";

describe("readClientAddress", () => {
	it("returns the address SvelteKit resolved", () => {
		expect(readClientAddress(() => "203.0.113.7")).toBe("203.0.113.7");
	});

	it("returns undefined instead of throwing when the address header is missing", () => {
		const missingHeader = () => {
			throw new Error("Address header was specified with ADDRESS_HEADER but is absent");
		};

		expect(readClientAddress(missingHeader)).toBeUndefined();
	});
});

describe("forwardingFetch", () => {
	it("adds the visitor's address and keeps the other headers", async () => {
		const base = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok")));
		const wrapped = forwardingFetch("203.0.113.7", base);

		await wrapped("http://api/notes/abc/exists", {
			method: "GET",
			headers: { authorization: "Bearer key" },
		});

		const [url, init] = base.mock.calls[0] ?? [];
		const headers = new Headers(init?.headers);
		expect(url).toBe("http://api/notes/abc/exists");
		expect(init?.method).toBe("GET");
		expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
		expect(headers.get("authorization")).toBe("Bearer key");
	});

	it("replaces any X-Forwarded-For already set", async () => {
		const base = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok")));

		await forwardingFetch("203.0.113.7", base)("http://api/", {
			headers: { "x-forwarded-for": "198.51.100.1" },
		});

		expect(new Headers(base.mock.calls[0]?.[1]?.headers).get("x-forwarded-for")).toBe(
			"203.0.113.7",
		);
	});

	it("works without request options", async () => {
		const base = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok")));

		await forwardingFetch("203.0.113.7", base)("http://api/");

		expect(new Headers(base.mock.calls[0]?.[1]?.headers).get("x-forwarded-for")).toBe(
			"203.0.113.7",
		);
	});
});
