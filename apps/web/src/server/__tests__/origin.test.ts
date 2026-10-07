// @vitest-environment node
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
	applyOrigin,
	ORIGIN_ADAPTER_ENV,
	ORIGIN_HOST_HEADER,
	ORIGIN_PROTOCOL_HEADER,
	parseOrigin,
} from "../origin.js";

describe("parseOrigin", () => {
	it.each([undefined, ""])("leaves the origin to adapter-node when ORIGIN is %j", (value) => {
		expect(parseOrigin(value)).toBeUndefined();
	});

	it("accepts http and https origins, trailing slash or not", () => {
		expect(parseOrigin("http://localhost:3000")?.host).toBe("localhost:3000");
		expect(parseOrigin("https://secret.example/")?.protocol).toBe("https:");
	});

	it.each(["not a url", "ftp://secret.example"])("refuses %j at startup", (value) => {
		expect(() => parseOrigin(value)).toThrow(`Invalid ORIGIN: ${value}`);
	});
});

describe("ORIGIN_ADAPTER_ENV", () => {
	it("points adapter-node at the private headers, with the port carried by the host", () => {
		expect(ORIGIN_ADAPTER_ENV).toEqual({
			PROTOCOL_HEADER: ORIGIN_PROTOCOL_HEADER,
			HOST_HEADER: ORIGIN_HOST_HEADER,
			PORT_HEADER: "",
		});
	});
});

describe("applyOrigin", () => {
	it("overwrites whatever the client sent in the private headers", () => {
		const req = {
			headers: { [ORIGIN_PROTOCOL_HEADER]: "https", [ORIGIN_HOST_HEADER]: "evil.example" },
		} as unknown as IncomingMessage;

		applyOrigin(req, new URL("http://nas.local:3000"));

		expect(req.headers[ORIGIN_PROTOCOL_HEADER]).toBe("http");
		expect(req.headers[ORIGIN_HOST_HEADER]).toBe("nas.local:3000");
	});
});
