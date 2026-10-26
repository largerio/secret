import { describe, expect, it } from "vitest";
import { readsLeft } from "../reads.js";

describe("readsLeft", () => {
	it("subtracts the reads already spent from the limit", () => {
		expect(readsLeft(3, 0)).toBe(3);
		expect(readsLeft(3, 2)).toBe(1);
	});

	it("never goes below zero", () => {
		expect(readsLeft(3, 5)).toBe(0);
	});

	it("cannot tell for a note without a limit", () => {
		expect(readsLeft(0, 0)).toBeNull();
	});

	it("cannot tell when the instance does not report the count", () => {
		expect(readsLeft(3, null)).toBeNull();
	});
});
