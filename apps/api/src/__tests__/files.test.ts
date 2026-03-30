import { describe, expect, it, afterAll } from "vitest";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { ensureFilesDir, saveFile, readFile, deleteFile } from "../storage/files.js";

const TEST_DIR = "./data/fs-test";

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ensureFilesDir", () => {
	it("creates directory if it does not exist", () => {
		const dir = `${TEST_DIR}/ensure-test`;
		ensureFilesDir(dir);
		expect(existsSync(dir)).toBe(true);
	});

	it("does not throw if directory already exists", () => {
		const dir = `${TEST_DIR}/ensure-exists`;
		mkdirSync(dir, { recursive: true });
		expect(() => ensureFilesDir(dir)).not.toThrow();
	});
});

describe("saveFile / readFile / deleteFile", () => {
	it("saves and reads a file", () => {
		const data = Buffer.from("hello world");
		const filePath = saveFile(TEST_DIR, "test-save", data);
		const read = readFile(filePath);
		expect(read).toEqual(data);
	});

	it("deletes a file", () => {
		const data = Buffer.from("to delete");
		const filePath = saveFile(TEST_DIR, "test-delete", data);
		expect(existsSync(filePath)).toBe(true);
		deleteFile(filePath);
		expect(existsSync(filePath)).toBe(false);
	});

	it("does not throw when deleting non-existent file", () => {
		expect(() => deleteFile(`${TEST_DIR}/nonexistent`)).not.toThrow();
	});
});
