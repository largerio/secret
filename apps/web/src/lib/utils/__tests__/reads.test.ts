import { describe, expect, it } from "vitest";
import { isLastRead, readsAfter, readsBefore, readsLeft } from "../reads.js";

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

describe("isLastRead", () => {
	it("is true for a single-read note, count known or not", () => {
		expect(isLastRead(1, 0)).toBe(true);
		expect(isLastRead(1, null)).toBe(true);
	});

	it("is true for a multi-read note down to its last read", () => {
		expect(isLastRead(3, 2)).toBe(true);
		expect(isLastRead(3, 1)).toBe(false);
	});

	it("is false when it cannot be told, or the note has no limit", () => {
		expect(isLastRead(3, null)).toBe(false);
		expect(isLastRead(0, 7)).toBe(false);
	});
});

describe("readsBefore", () => {
	it("counts the reads left when the instance reports them", () => {
		expect(readsBefore(3, 1)).toEqual({ kind: "left", count: 2 });
	});

	it("falls back to the limit on an older instance", () => {
		expect(readsBefore(10, null)).toEqual({ kind: "total", count: 10 });
	});

	it("says nothing for a note without a limit", () => {
		expect(readsBefore(0, null)).toEqual({ kind: "none" });
	});
});

describe("readsAfter", () => {
	it("knows a single-read note is gone without asking", () => {
		expect(readsAfter(1, null)).toEqual({ kind: "gone" });
	});

	it("trusts the server that the note no longer exists", () => {
		expect(readsAfter(3, { exists: false })).toEqual({ kind: "gone" });
	});

	it("reports the reads the server says are left", () => {
		expect(readsAfter(3, { exists: true, readCount: 1 })).toEqual({ kind: "left", count: 2 });
	});

	it("calls a note with no reads left gone", () => {
		expect(readsAfter(3, { exists: true, readCount: 3 })).toEqual({ kind: "gone" });
	});

	it("stays vague when the count is unknown or the server could not be asked", () => {
		expect(readsAfter(3, { exists: true, readCount: null })).toEqual({ kind: "limited" });
		expect(readsAfter(3, null)).toEqual({ kind: "limited" });
	});

	it("has nothing to count on a note without a limit", () => {
		expect(readsAfter(0, { exists: true, readCount: 0 })).toEqual({ kind: "unlimited" });
	});
});
