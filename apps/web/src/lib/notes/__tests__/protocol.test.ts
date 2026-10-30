import {
	SecretApiError,
	SecretDecryptionError,
	SecretNetworkError,
	SecretValidationError,
} from "@largerio/secret-sdk";
import { describe, expect, it } from "vitest";
import { receivedError, sentError } from "../protocol.js";

/** An error as the page receives it from the worker, through a structured clone. */
const across = (error: unknown) => receivedError(structuredClone(sentError(error)));

describe("an error sent from the worker", () => {
	it("is an API error again, with its status, code and Retry-After", () => {
		const error = across(
			new SecretApiError("Too many requests", 429, { code: "rate_limited", retryAfter: 30 }),
		);
		expect(error).toBeInstanceOf(SecretApiError);
		expect(error).toMatchObject({
			message: "Too many requests",
			status: 429,
			code: "rate_limited",
			retryAfter: 30,
		});
	});

	it("is an API error without a code when the answer named none", () => {
		const error = across(new SecretApiError("HTTP 403", 403));
		expect(error).toBeInstanceOf(SecretApiError);
		expect((error as SecretApiError).code).toBeUndefined();
		expect((error as SecretApiError).retryAfter).toBeUndefined();
	});

	it.each([
		["a failed decryption", new SecretDecryptionError(), SecretDecryptionError],
		["a network failure", new SecretNetworkError("Network request failed"), SecretNetworkError],
		["a refused input", new SecretValidationError("Invalid key fragment"), SecretValidationError],
	])("is %s again", (_, sent, type) => {
		const error = across(sent);
		expect(error).toBeInstanceOf(type);
		expect(error.message).toBe(sent.message);
	});

	it("is a plain error otherwise, keeping its message", () => {
		expect(across(new TypeError("broken"))).toEqual(new Error("broken"));
		expect(across("thrown as is")).toEqual(new Error("thrown as is"));
	});
});
