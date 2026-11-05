import { MAX_TEXT_SIZE } from "@largerio/secret-sdk";
import { describe, expect, it, vi } from "vitest";
import { EXIT } from "../errors.js";
import { readText } from "../stdin.js";
import type { InputStream } from "../types.js";
import { input } from "./harness.js";

const signal = new AbortController().signal;

describe("readText", () => {
	it("reads every chunk to the end, exactly", async () => {
		// Built, not written: the formatter writes a BOM escape as the character itself.
		const bom = String.fromCharCode(0xfeff);
		expect(await readText(input([`${bom}one `, "two\r\n", "  "]), signal)).toBe(
			`${bom}one two\r\n  `,
		);
	});

	it("reads a character split between chunks", async () => {
		const bytes = new TextEncoder().encode("é");
		expect(await readText(input([bytes.slice(0, 1), bytes.slice(1)]), signal)).toBe("é");
	});

	it("reads nothing as an empty text", async () => {
		expect(await readText(input([]), signal)).toBe("");
	});

	it("takes the longest text a note holds", async () => {
		const text = "a".repeat(MAX_TEXT_SIZE);
		expect(await readText(input([text]), signal)).toBe(text);
	});

	it("refuses more characters than a note holds", async () => {
		await expect(readText(input(["a".repeat(MAX_TEXT_SIZE + 1)]), signal)).rejects.toMatchObject({
			exitCode: EXIT.usage,
			message: expect.stringContaining("send it as a file"),
		});
	});

	it("stops reading past the bytes that many characters can take", async () => {
		const chunk = new Uint8Array(100_000).fill(0x61);
		const read = vi.fn();
		const endless: InputStream = {
			isTTY: false,
			async *[Symbol.asyncIterator]() {
				for (;;) {
					read();
					yield chunk;
				}
			},
		};
		await expect(readText(endless, signal)).rejects.toMatchObject({ exitCode: EXIT.usage });
		expect(read).toHaveBeenCalledTimes(4);
	});

	it("refuses what is not UTF-8", async () => {
		await expect(readText(input([new Uint8Array([0x61, 0xff])]), signal)).rejects.toMatchObject({
			message: "stdin is not UTF-8 text: send it as a file",
			exitCode: EXIT.usage,
		});
	});

	it("stops at an abort, even while a read waits", async () => {
		const controller = new AbortController();
		const returned = vi.fn(() => Promise.reject(new Error("already closed")));
		const waiting: InputStream = {
			isTTY: true,
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise(() => undefined),
				return: returned,
			}),
		};
		const reading = readText(waiting, controller.signal);
		controller.abort(new Error("interrupted"));
		await expect(reading).rejects.toThrow("interrupted");
		expect(returned).toHaveBeenCalledOnce();
	});

	it("reads nothing once aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("interrupted"));
		await expect(readText(input(["text"]), controller.signal)).rejects.toThrow("interrupted");
	});

	it("passes on the failure of the stream, from an iterator without return", async () => {
		const failing: InputStream = {
			isTTY: false,
			[Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("EIO")) }),
		};
		await expect(readText(failing, signal)).rejects.toThrow("EIO");
	});
});
