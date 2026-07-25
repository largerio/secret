import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The existing auth tests only assert the boolean result, so they all still
 * pass if someone "simplifies" verifyApiKeyBuffers by returning early on the
 * first match, or by swapping timingSafeEqual for `Buffer.equals` — either of
 * which reintroduces a timing oracle on the API key.
 *
 * These tests observe the *work performed* instead. They live in their own file
 * because the node:crypto mock is hoisted to module scope; it delegates to the
 * real implementation, so behaviour is unchanged.
 */
const { calls } = vi.hoisted(() => ({ calls: [] as Array<[Buffer, Buffer]> }));

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
			calls.push([a as Buffer, b as Buffer]);
			return actual.timingSafeEqual(a, b);
		},
	};
});

const { verifyApiKeyBuffers } = await import("../auth.js");

const KEYS = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
const BUFFERS = KEYS.map((k) => Buffer.from(k));

beforeEach(() => {
	calls.length = 0;
});

describe("verifyApiKeyBuffers timing behaviour", () => {
	it("compares every configured key, even once one has matched", () => {
		expect(verifyApiKeyBuffers(KEYS[0] as string, BUFFERS)).toBe(true);
		const afterMatch = calls.length;

		calls.length = 0;
		expect(verifyApiKeyBuffers("nomatch", BUFFERS)).toBe(false);
		const afterMiss = calls.length;

		// An early return on the first match would make these differ (1 vs 3).
		expect(afterMatch).toBe(KEYS.length);
		expect(afterMiss).toBe(KEYS.length);
	});

	it("does constant work whatever the candidate's length", () => {
		for (const candidate of ["", "x", "x".repeat(32), "x".repeat(5000)]) {
			calls.length = 0;
			expect(verifyApiKeyBuffers(candidate, BUFFERS)).toBe(false);

			expect(calls).toHaveLength(KEYS.length);
			// Both operands are sized by the known key, never by the candidate —
			// that is what keeps the comparison cost independent of the guess.
			for (const [a, b] of calls) {
				expect(a.length).toBe(32);
				expect(b.length).toBe(32);
			}
		}
	});

	it("still uses timingSafeEqual rather than a plain buffer compare", () => {
		verifyApiKeyBuffers("whatever", BUFFERS);
		expect(calls.length).toBeGreaterThan(0);
	});
});
