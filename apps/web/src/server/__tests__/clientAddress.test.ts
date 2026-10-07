// @vitest-environment node
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { type AddressConfig, parseAddressConfig, resolveClientAddress } from "../clientAddress.js";

function fakeRequest(headers: Record<string, string> = {}, remoteAddress = "10.0.0.5") {
	return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

const xff = (xffDepth: number): AddressConfig => ({ addressHeader: "x-forwarded-for", xffDepth });

describe("parseAddressConfig", () => {
	it("defaults to the socket peer and a depth of 1", () => {
		expect(parseAddressConfig({})).toEqual({ addressHeader: "", xffDepth: 1 });
	});

	it("lower-cases the header name, since Node lower-cases incoming headers", () => {
		expect(parseAddressConfig({ ADDRESS_HEADER: "X-Forwarded-For", XFF_DEPTH: "2" })).toEqual({
			addressHeader: "x-forwarded-for",
			xffDepth: 2,
		});
	});
});

describe("resolveClientAddress", () => {
	it("uses the socket peer when no address header is configured", () => {
		const req = fakeRequest({ "x-forwarded-for": "1.2.3.4" });

		expect(resolveClientAddress(req, { addressHeader: "", xffDepth: 1 })).toBe("10.0.0.5");
	});

	it("reads a single-value address header as is", () => {
		const req = fakeRequest({ "x-real-ip": "198.51.100.9" });

		expect(resolveClientAddress(req, { addressHeader: "x-real-ip", xffDepth: 1 })).toBe(
			"198.51.100.9",
		);
	});

	it("returns undefined, instead of throwing, when the configured header is missing", () => {
		// Every request that skips the reverse proxy, starting with the
		// container health check.
		expect(resolveClientAddress(fakeRequest(), xff(1))).toBeUndefined();
	});

	it("returns undefined for an empty header", () => {
		const req = fakeRequest({ "x-real-ip": "" });

		expect(resolveClientAddress(req, { addressHeader: "x-real-ip", xffDepth: 1 })).toBeUndefined();
	});

	it("takes the entry XFF_DEPTH hops from the right, ignoring what the client prefilled", () => {
		const req = fakeRequest({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.1" });

		expect(resolveClientAddress(req, xff(1))).toBe("10.0.0.1");
		expect(resolveClientAddress(req, xff(2))).toBe("203.0.113.7");
	});

	it.each([
		["deeper than the list", 3],
		["zero", 0],
		["negative", -1],
		["not a number", Number.NaN],
	])("returns undefined when the depth is %s", (_label, depth) => {
		const req = fakeRequest({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });

		expect(resolveClientAddress(req, xff(depth))).toBeUndefined();
	});

	it("returns undefined when the selected entry is blank", () => {
		const req = fakeRequest({ "x-forwarded-for": " , 10.0.0.1" });

		expect(resolveClientAddress(req, xff(2))).toBeUndefined();
	});
});
