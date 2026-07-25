import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyWithFeedback } from "../clipboard.js";

/**
 * jsdom does not implement execCommand, so define it on the real document
 * rather than replacing the global: a plain object spread loses every
 * prototype method (createElement, body, …) the fallback needs.
 */
function stubExecCommand(impl: () => boolean) {
	const spy = vi.fn(impl);
	Object.defineProperty(document, "execCommand", { value: spy, configurable: true });
	return spy;
}

describe("copyWithFeedback", () => {
	const writeText = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		writeText.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("copies text and toggles the copied flag", async () => {
		writeText.mockResolvedValue(undefined);
		const setCopied = vi.fn();

		const ok = await copyWithFeedback("secret-url", setCopied);

		expect(ok).toBe(true);
		expect(writeText).toHaveBeenCalledWith("secret-url");
		expect(setCopied).toHaveBeenCalledWith(true);

		vi.advanceTimersByTime(2000);
		expect(setCopied).toHaveBeenCalledWith(false);
	});

	it("respects a custom reset delay", async () => {
		writeText.mockResolvedValue(undefined);
		const setCopied = vi.fn();

		await copyWithFeedback("text", setCopied, 5000);
		expect(setCopied).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(2000);
		expect(setCopied).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(3000);
		expect(setCopied).toHaveBeenCalledTimes(2);
		expect(setCopied).toHaveBeenLastCalledWith(false);
	});

	it("falls back to execCommand when the clipboard API is unavailable", async () => {
		// The situation on a self-hosted instance served over plain HTTP:
		// navigator.clipboard simply does not exist outside a secure context.
		writeText.mockRejectedValue(new TypeError("not a function"));
		const execCommand = stubExecCommand(() => true);
		const setCopied = vi.fn();

		const ok = await copyWithFeedback("secret-url", setCopied);

		expect(ok).toBe(true);
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(setCopied).toHaveBeenCalledWith(true);
	});

	it("returns false when both the clipboard API and execCommand fail", async () => {
		writeText.mockRejectedValue(new Error("denied"));
		stubExecCommand(() => false);
		const setCopied = vi.fn();

		const ok = await copyWithFeedback("text", setCopied);

		expect(ok).toBe(false);
		expect(setCopied).not.toHaveBeenCalled();
	});

	it("returns false when execCommand throws", async () => {
		writeText.mockRejectedValue(new Error("denied"));
		stubExecCommand(() => {
			throw new Error("blocked");
		});

		expect(await copyWithFeedback("text", vi.fn())).toBe(false);
	});

	it("returns false when there is no document at all (SSR)", async () => {
		writeText.mockRejectedValue(new Error("denied"));
		vi.stubGlobal("document", undefined);

		expect(await copyWithFeedback("text", vi.fn())).toBe(false);
	});
});
