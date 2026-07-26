import { describe, expect, it } from "vitest";
import { SecretNetworkError } from "../errors.js";

describe("SecretNetworkError", () => {
	it("carries the underlying failure as cause", () => {
		const original = new TypeError("fetch failed");
		const err = new SecretNetworkError("Network request failed", { cause: original });

		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("SecretNetworkError");
		expect(err.cause).toBe(original);
	});

	it("is usable without a cause", () => {
		const err = new SecretNetworkError("offline");

		expect(err.cause).toBeUndefined();
		expect(err.message).toBe("offline");
	});
});
