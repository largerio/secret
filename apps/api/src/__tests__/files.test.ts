import { existsSync, mkdirSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { deleteFile, ensureFilesDir, readFile, saveFile } from "../storage/files.js";
import { LocalStorage } from "../storage/local.js";

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

describe("LocalStorage", () => {
	const storageDir = `${TEST_DIR}/local-storage`;

	it("saves and reads data through the interface", async () => {
		const storage = new LocalStorage(storageDir);
		const data = Buffer.from("local-storage-test");
		const key = await storage.save("ls-test-1", data);
		const read = await storage.read(key);
		expect(read).toEqual(data);
	});

	it("deletes data through the interface", async () => {
		const storage = new LocalStorage(storageDir);
		const data = Buffer.from("to-delete");
		const key = await storage.save("ls-test-2", data);
		expect(existsSync(key)).toBe(true);
		await storage.delete(key);
		expect(existsSync(key)).toBe(false);
	});

	it("does not throw when deleting non-existent key", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.delete(`${storageDir}/nonexistent`)).resolves.not.toThrow();
	});

	it("returns the file path as storage key", async () => {
		const storage = new LocalStorage(storageDir);
		const key = await storage.save("ls-test-3", Buffer.from("test"));
		expect(key).toContain("ls-test-3");
		expect(key).toContain("local-storage");
	});

	it("handles binary data correctly", async () => {
		const storage = new LocalStorage(storageDir);
		const data = Buffer.from([0, 1, 127, 128, 255]);
		const key = await storage.save("ls-binary", data);
		const read = await storage.read(key);
		expect(read).toEqual(data);
	});
});
