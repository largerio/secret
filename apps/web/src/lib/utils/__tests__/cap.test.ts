import { afterEach, describe, expect, it, vi } from "vitest";

const solve = vi.fn();
const capOpts: unknown[] = [];

// `@cap.js/widget` default export is a class instantiated with `new`, so the
// mock must be constructable.
class FakeCap {
	constructor(opts: unknown) {
		capOpts.push(opts);
	}
	solve = solve;
}

vi.mock("@cap.js/widget", () => ({ default: FakeCap }));

import { solveCap } from "../cap.js";

afterEach(() => {
	solve.mockReset();
	capOpts.length = 0;
});

describe("solveCap", () => {
	it("configures the wasm URL, points the widget at /api/cap/, and returns the token", async () => {
		solve.mockResolvedValue({ success: true, token: "pow-token" });

		const token = await solveCap();

		expect(token).toBe("pow-token");
		expect(window.CAP_CUSTOM_WASM_URL).toBe("/wasm/cap_wasm_bg.wasm");
		expect(capOpts.at(-1)).toEqual({ apiEndpoint: "/api/cap/" });
	});

	it("throws when the challenge is not solved", async () => {
		solve.mockResolvedValue({ success: false, token: null });
		await expect(solveCap()).rejects.toThrow();
	});

	it("throws when the solved result has no token", async () => {
		solve.mockResolvedValue({ success: true, token: "" });
		await expect(solveCap()).rejects.toThrow();
	});
});
