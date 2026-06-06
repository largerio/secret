import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `getClient` lazily imports the SDK and memoizes the resulting promise, so each
// test resets the module registry to get a fresh singleton and stubs the SDK.
describe("getClient", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("@secret/sdk-js");
	});

	it("creates the client once and caches it across calls", async () => {
		const fakeClient = { tag: "client" };
		const create = vi.fn().mockResolvedValue(fakeClient);
		vi.doMock("@secret/sdk-js", () => ({ SecretClient: { create } }));

		const { getClient } = await import("../client.js");
		const first = await getClient();
		const second = await getClient();

		expect(first).toBe(fakeClient);
		expect(second).toBe(fakeClient);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("clears the cached promise after a failure so a retry re-imports", async () => {
		const fakeClient = { tag: "client" };
		const create = vi
			.fn()
			.mockRejectedValueOnce(new Error("wasm init failed"))
			.mockResolvedValueOnce(fakeClient);
		vi.doMock("@secret/sdk-js", () => ({ SecretClient: { create } }));

		const { getClient } = await import("../client.js");

		await expect(getClient()).rejects.toThrow("wasm init failed");
		// The failed promise must not be sticky — a second call retries creation.
		await expect(getClient()).resolves.toBe(fakeClient);
		expect(create).toHaveBeenCalledTimes(2);
	});
});
