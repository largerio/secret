import { describe, expect, it } from "vitest";
import { attachFiles } from "../files.js";

const limits = { maxFileSize: 1000, maxFilesPerNote: 3 };

function file(name: string, size: number): File {
	return new File([new Uint8Array(size)], name);
}

describe("attachFiles", () => {
	it("adds files that fit", () => {
		const a = file("a.txt", 100);
		const b = file("b.txt", 200);
		expect(attachFiles([a], [b], limits)).toEqual({ files: [a, b], error: null });
	});

	it("refuses the whole batch when one file is too large", () => {
		const kept = file("kept.txt", 10);
		const result = attachFiles([kept], [file("ok.txt", 10), file("big.bin", 1001)], limits);
		expect(result).toEqual({ files: [kept], error: { kind: "fileTooLarge", limit: 1000 } });
	});

	it("keeps what fits under the count limit and reports how many were dropped", () => {
		const existing = [file("1", 10), file("2", 10)];
		const result = attachFiles(existing, [file("3", 10), file("4", 10), file("5", 10)], limits);
		expect(result.files.map((f) => f.name)).toEqual(["1", "2", "3"]);
		expect(result.error).toEqual({ kind: "tooMany", max: 3, ignored: 2 });
	});

	it("drops the whole batch, with a message, when the note is already full", () => {
		const full = [file("1", 10), file("2", 10), file("3", 10)];
		const result = attachFiles(full, [file("4", 10)], limits);
		expect(result.files).toEqual(full);
		expect(result.error).toEqual({ kind: "tooMany", max: 3, ignored: 1 });
	});

	it("refuses a batch that would push the total over the size limit", () => {
		const kept = file("kept", 600);
		const result = attachFiles([kept], [file("more", 500)], limits);
		expect(result).toEqual({ files: [kept], error: { kind: "totalTooLarge", limit: 1000 } });
	});

	it("never mutates the current list", () => {
		const current = [file("a", 10)];
		attachFiles(current, [file("b", 10)], limits);
		expect(current).toHaveLength(1);
	});
});
