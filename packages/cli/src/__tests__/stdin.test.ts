import { MAX_TEXT_SIZE } from "@largerio/secret-sdk";
import { describe, expect, it, vi } from "vitest";
import { EXIT } from "../errors.js";
import { MAX_LINK_BYTES, readLink, readText } from "../stdin.js";
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

describe("readLink", () => {
	it("reads the first line, without the spaces around it, and nothing after it", async () => {
		const read = vi.fn();
		const stdin: InputStream = {
			isTTY: false,
			async *[Symbol.asyncIterator]() {
				yield new TextEncoder().encode("  https://secret.exa");
				yield new TextEncoder().encode("mple/note/x\r\nsecond line");
				read();
				yield new TextEncoder().encode("never read");
			},
		};
		expect(await readLink(stdin, signal)).toBe("https://secret.example/note/x");
		expect(read).not.toHaveBeenCalled();
	});

	it("reads a link without a line feed to the end of stdin", async () => {
		expect(await readLink(input(["https://secret.example/note/x"]), signal)).toBe(
			"https://secret.example/note/x",
		);
	});

	it("takes a line as long as a link may be", async () => {
		const longest = "a".repeat(MAX_LINK_BYTES);
		expect(await readLink(input([`${longest}\n`]), signal)).toBe(longest);
	});

	it("refuses a longer line", async () => {
		await expect(
			readLink(input(["a".repeat(MAX_LINK_BYTES), "a\n"]), signal),
		).rejects.toMatchObject({
			message: "the first line of stdin is longer than a link",
			exitCode: EXIT.usage,
		});
	});

	it.each([[[]], [["\n", "https://secret.example/note/x"]], [[" \r\n"]]])(
		"refuses a first line without a link: %j",
		async (chunks) => {
			await expect(readLink(input(chunks), signal)).rejects.toMatchObject({
				message: "no link on stdin: pipe it in, or give it: secret read <link>",
				exitCode: EXIT.usage,
			});
		},
	);
});
