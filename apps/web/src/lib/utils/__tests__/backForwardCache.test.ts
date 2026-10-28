import { describe, expect, it, vi } from "vitest";
import { onBackForwardCache } from "../backForwardCache.js";

const transition = (type: "pagehide" | "pageshow", persisted: boolean) =>
	window.dispatchEvent(new PageTransitionEvent(type, { persisted }));

describe("onBackForwardCache", () => {
	it("forgets as the page is put away, restores as it comes back", () => {
		const forget = vi.fn();
		const restore = vi.fn();
		const stop = onBackForwardCache(forget, restore);

		transition("pagehide", true);
		expect(forget).toHaveBeenCalledOnce();
		expect(restore).not.toHaveBeenCalled();

		transition("pageshow", true);
		expect(restore).toHaveBeenCalledOnce();
		stop();
	});

	it("ignores a page that is unloaded or loaded for good", () => {
		const forget = vi.fn();
		const restore = vi.fn();
		const stop = onBackForwardCache(forget, restore);

		transition("pagehide", false);
		transition("pageshow", false);
		expect(forget).not.toHaveBeenCalled();
		expect(restore).not.toHaveBeenCalled();
		stop();
	});

	it("needs nothing on the way back", () => {
		const forget = vi.fn();
		const stop = onBackForwardCache(forget);

		expect(() => transition("pageshow", true)).not.toThrow();
		stop();
	});

	it("stops listening", () => {
		const forget = vi.fn();
		const restore = vi.fn();
		onBackForwardCache(forget, restore)();

		transition("pagehide", true);
		transition("pageshow", true);
		expect(forget).not.toHaveBeenCalled();
		expect(restore).not.toHaveBeenCalled();
	});
});
