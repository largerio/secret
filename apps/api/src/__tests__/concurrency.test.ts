import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../concurrency.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("runWithConcurrency", () => {
	it("does nothing for an empty array (no workers spawned)", async () => {
		let calls = 0;
		await runWithConcurrency([], 4, async () => {
			calls++;
		});
		expect(calls).toBe(0);
	});

	it("processes a single item", async () => {
		const seen: number[] = [];
		await runWithConcurrency([42], 4, async (n) => {
			seen.push(n);
		});
		expect(seen).toEqual([42]);
	});

	it("processes every item exactly once", async () => {
		const items = Array.from({ length: 50 }, (_, i) => i);
		const seen: number[] = [];
		await runWithConcurrency(items, 8, async (n) => {
			await tick();
			seen.push(n);
		});
		expect(seen.slice().sort((a, b) => a - b)).toEqual(items);
		expect(new Set(seen).size).toBe(items.length);
	});

	it("caps the number of in-flight workers to the limit", async () => {
		const items = Array.from({ length: 20 }, (_, i) => i);
		let inFlight = 0;
		let maxInFlight = 0;
		await runWithConcurrency(items, 4, async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await tick();
			inFlight--;
		});
		expect(maxInFlight).toBeLessThanOrEqual(4);
		expect(maxInFlight).toBeGreaterThan(1); // proves it actually parallelizes
	});

	it("never spawns more runners than there are items when limit exceeds length", async () => {
		const items = [1, 2];
		let inFlight = 0;
		let maxInFlight = 0;
		await runWithConcurrency(items, 10, async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await tick();
			inFlight--;
		});
		expect(maxInFlight).toBeLessThanOrEqual(items.length);
	});

	it("propagates a worker rejection", async () => {
		await expect(
			runWithConcurrency([1, 2, 3], 2, async (n) => {
				if (n === 2) throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});
});
