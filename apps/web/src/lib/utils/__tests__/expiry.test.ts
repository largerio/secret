import { EXPIRATION_OPTIONS, MAX_EXPIRY_SECONDS } from "@largerio/secret-shared";
import { describe, expect, it } from "vitest";
import { allowedExpirationOptions, defaultExpiration, expiryLabelKey } from "../expiry.js";

describe("allowedExpirationOptions", () => {
	it("lists every option when the ceiling is the protocol maximum", () => {
		expect(allowedExpirationOptions(MAX_EXPIRY_SECONDS)).toHaveLength(EXPIRATION_OPTIONS.length);
	});

	it("hides options the server would reject", () => {
		// The regression this exists to prevent: an operator sets MAX_EXPIRY to
		// 7 days, the picker keeps offering "30 days", and choosing it fails with
		// a raw 400 from the API.
		const options = allowedExpirationOptions(604_800);

		expect(options.map((o) => o.value)).toEqual([300, 3600, 86_400, 604_800]);
		expect(options.some((o) => o.value === 2_592_000)).toBe(false);
	});

	it("never returns an empty picker", () => {
		// Below even the shortest option, offering it and letting the server
		// reject it beats rendering a select with no choices.
		expect(allowedExpirationOptions(60)).toHaveLength(1);
		expect(allowedExpirationOptions(60)[0]?.value).toBe(300);
	});
});

describe("defaultExpiration", () => {
	it("keeps the 24h default when it fits", () => {
		expect(defaultExpiration(MAX_EXPIRY_SECONDS)).toBe(86_400);
		expect(defaultExpiration(86_400)).toBe(86_400);
	});

	it("falls back to the longest allowed option when the default is too long", () => {
		expect(defaultExpiration(3600)).toBe(3600);
	});

	it("returns the shortest option when the ceiling is below all of them", () => {
		expect(defaultExpiration(60)).toBe(300);
	});
});

describe("expiryLabelKey", () => {
	it("names every duration the picker offers", () => {
		for (const option of EXPIRATION_OPTIONS) {
			expect(expiryLabelKey(option.value)).toBe(option.labelKey);
		}
	});

	it("names nothing it does not offer, rather than mislabelling it", () => {
		expect(expiryLabelKey(42)).toBeUndefined();
	});
});
