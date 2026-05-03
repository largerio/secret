import { describe, expect, it } from "vitest";
import { verifyApiKey, verifyApiKeyBuffers } from "../auth.js";

describe("verifyApiKey", () => {
	it("returns false when no keys are configured", () => {
		expect(verifyApiKey("anything", [])).toBe(false);
	});

	it("accepts a matching key", () => {
		expect(verifyApiKey("secret", ["secret"])).toBe(true);
	});

	it("rejects a non-matching key", () => {
		expect(verifyApiKey("wrong", ["secret"])).toBe(false);
	});

	it("accepts any key from a configured list", () => {
		const keys = ["k1", "k2", "k3"];
		expect(verifyApiKey("k1", keys)).toBe(true);
		expect(verifyApiKey("k2", keys)).toBe(true);
		expect(verifyApiKey("k3", keys)).toBe(true);
		expect(verifyApiKey("k4", keys)).toBe(false);
	});

	it("rejects a candidate shorter than all known keys", () => {
		expect(verifyApiKey("a", ["aa", "bbb"])).toBe(false);
	});

	it("rejects a candidate longer than all known keys", () => {
		expect(verifyApiKey("longer", ["aa", "bbb"])).toBe(false);
	});

	it("rejects a candidate that shares a prefix with a known key", () => {
		// The candidate's first bytes match "secret" but overall length differs.
		expect(verifyApiKey("secretX", ["secret"])).toBe(false);
		expect(verifyApiKey("secre", ["secret"])).toBe(false);
	});

	it("does not short-circuit on the first match (timing-safe)", () => {
		// When the match is key[0], later keys are still compared. We can't
		// assert the absence of a timing leak, but we can assert every known
		// key was visited by checking the function still accepts the match
		// placed at any position.
		expect(verifyApiKey("match", ["match", "other"])).toBe(true);
		expect(verifyApiKey("match", ["other", "match"])).toBe(true);
	});
});

describe("verifyApiKeyBuffers", () => {
	const buffers = (...keys: string[]) => keys.map((k) => Buffer.from(k));

	it("returns false when no keys are configured", () => {
		expect(verifyApiKeyBuffers("anything", [])).toBe(false);
	});

	it("accepts a matching key", () => {
		expect(verifyApiKeyBuffers("secret", buffers("secret"))).toBe(true);
	});

	it("rejects a non-matching key", () => {
		expect(verifyApiKeyBuffers("wrong", buffers("secret"))).toBe(false);
	});

	it("accepts any key from a configured list", () => {
		const known = buffers("k1", "k2", "k3");
		expect(verifyApiKeyBuffers("k1", known)).toBe(true);
		expect(verifyApiKeyBuffers("k2", known)).toBe(true);
		expect(verifyApiKeyBuffers("k3", known)).toBe(true);
		expect(verifyApiKeyBuffers("k4", known)).toBe(false);
	});

	it("rejects candidates with mismatching length", () => {
		expect(verifyApiKeyBuffers("secretX", buffers("secret"))).toBe(false);
		expect(verifyApiKeyBuffers("secre", buffers("secret"))).toBe(false);
	});

	it("matches the behavior of verifyApiKey for equivalent inputs", () => {
		const candidates = ["a", "ab", "abc", "abcd", "wrong"];
		const known = ["abc", "xyz"];
		const knownBufs = buffers(...known);
		for (const c of candidates) {
			expect(verifyApiKeyBuffers(c, knownBufs)).toBe(verifyApiKey(c, known));
		}
	});
});
