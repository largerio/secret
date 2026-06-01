import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyWithFeedback } from "../clipboard.js";

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

	it("returns false when the clipboard API rejects", async () => {
		writeText.mockRejectedValue(new Error("denied"));
		const setCopied = vi.fn();

		const ok = await copyWithFeedback("text", setCopied);

		expect(ok).toBe(false);
		expect(setCopied).not.toHaveBeenCalled();
	});
});
