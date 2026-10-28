import { SecretApiError, SecretDecryptionError, SecretNetworkError } from "@largerio/secret-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "#lib/i18n/index.svelte.js";
import { isUnreachable, requestErrorMessage } from "../errors.js";

const api = (status: number) => new SecretApiError("from the server", status);

describe("requestErrorMessage", () => {
	afterEach(() => {
		setLocale("en");
	});

	it.each([
		[new SecretNetworkError("Network request failed"), "error_network"],
		[api(0), "error_network"],
		[api(401), "error_check_failed"],
		[api(413), "error_too_large"],
		[api(429), "error_rate_limited"],
		[api(507), "error_storage_full"],
		[api(500), "error_server"],
		[api(503), "error_server"],
		[api(400), "error_generic"],
		[api(404), "error_generic"],
		[new SecretDecryptionError(), "error_generic"],
		[new Error("Failed to fetch"), "error_generic"],
		["not an error", "error_generic"],
	] as const)("maps %s to %s", (error, key) => {
		expect(requestErrorMessage(error)).toBe(t(key));
	});

	it("speaks the reader's language, never the server's English", () => {
		const english = requestErrorMessage(api(429));
		setLocale("fr");
		const french = requestErrorMessage(api(429));
		expect(french).not.toBe(english);
		expect(french).not.toContain("from the server");
	});
});

describe("isUnreachable", () => {
	it("holds when the server could not be asked or could not answer", () => {
		expect(isUnreachable(new SecretNetworkError("down"))).toBe(true);
		expect(isUnreachable(api(0))).toBe(true);
		expect(isUnreachable(api(500))).toBe(true);
		expect(isUnreachable(api(503))).toBe(true);
	});

	it("does not hold when the server answered", () => {
		expect(isUnreachable(api(404))).toBe(false);
		expect(isUnreachable(api(429))).toBe(false);
		expect(isUnreachable(new SecretDecryptionError())).toBe(false);
		expect(isUnreachable(new Error("other"))).toBe(false);
	});
});
