import { describe, expect, it } from "vitest";
import { getStep, setStep } from "../steps.svelte.js";

describe("steps store", () => {
	it("defaults to step 1", () => {
		expect(getStep()).toBe(1);
	});

	it("updates the active step via setStep", () => {
		setStep(3);
		expect(getStep()).toBe(3);
		setStep(1);
		expect(getStep()).toBe(1);
	});
});
