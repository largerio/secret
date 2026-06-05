import { existsSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StorageInvalidKeyError, StorageNotFoundError } from "../storage/errors.js";
import { LocalStorage } from "../storage/local.js";

const TEST_DIR = "./data/fs-test";

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
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

	it("writes files with owner-only permissions (0o600)", async () => {
		const storage = new LocalStorage(storageDir);
		const key = await storage.save("ls-perms", Buffer.from("secret"));
		expect((await stat(key)).mode & 0o777).toBe(0o600);
	});

	it("writes chunk files and directories with owner-only permissions", async () => {
		const storage = new LocalStorage(storageDir);
		const chunkKey = await storage.saveChunk("ls-chunk-perms", 0, Buffer.from("c"));
		expect((await stat(chunkKey)).mode & 0o777).toBe(0o600);
		expect((await stat(dirname(chunkKey))).mode & 0o777).toBe(0o700);
	});

	it("rejects path traversal in save", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.save("../../etc/passwd", Buffer.from("x"))).rejects.toThrow(
			"Path traversal detected",
		);
	});

	it("rejects path traversal in read", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.read("/etc/passwd")).rejects.toThrow("Path traversal detected");
	});

	it("rejects path traversal in delete", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.delete("/etc/passwd")).resolves.not.toThrow();
	});

	it("rejects sibling directory with similar prefix", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.read(`${storageDir}-evil/secret`)).rejects.toThrow(
			"Path traversal detected",
		);
	});

	it("saves and reads chunks in a roundtrip", async () => {
		const storage = new LocalStorage(storageDir);
		const chunk0 = Buffer.from("chunk-zero-data");
		const chunk1 = Buffer.from("chunk-one-data!");

		const key0 = await storage.saveChunk("chunked-note-1", 0, chunk0);
		const key1 = await storage.saveChunk("chunked-note-1", 1, chunk1);

		expect(key0).toContain("chunked-note-1");
		expect(key0).toContain("chunk_0");
		expect(key1).toContain("chunk_1");

		const read0 = await storage.readChunk("chunked-note-1", 0);
		const read1 = await storage.readChunk("chunked-note-1", 1);

		expect(read0).toEqual(chunk0);
		expect(read1).toEqual(chunk1);
	});

	it("deleteChunks removes all chunks and directory", async () => {
		const storage = new LocalStorage(storageDir);
		const chunk0 = Buffer.from("to-delete-0");
		const chunk1 = Buffer.from("to-delete-1");

		await storage.saveChunk("del-chunks-1", 0, chunk0);
		await storage.saveChunk("del-chunks-1", 1, chunk1);

		// Verify chunks exist
		const read0 = await storage.readChunk("del-chunks-1", 0);
		expect(read0).toEqual(chunk0);

		await storage.deleteChunks("del-chunks-1", 2);

		// Chunks should no longer be readable
		await expect(storage.readChunk("del-chunks-1", 0)).rejects.toThrow();
		await expect(storage.readChunk("del-chunks-1", 1)).rejects.toThrow();
	});

	it("deleteChunks does not throw for missing chunks", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.deleteChunks("nonexistent-note", 3)).resolves.not.toThrow();
	});

	it("read throws StorageNotFoundError for missing files", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.read(`${storageDir}/does-not-exist`)).rejects.toBeInstanceOf(
			StorageNotFoundError,
		);
	});

	it("readChunk throws StorageNotFoundError for missing chunks", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.readChunk("never-saved", 0)).rejects.toBeInstanceOf(StorageNotFoundError);
	});

	it("path traversal raises StorageInvalidKeyError", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.read("/etc/passwd")).rejects.toBeInstanceOf(StorageInvalidKeyError);
	});

	it("read re-throws non-ENOENT filesystem errors", async () => {
		const storage = new LocalStorage(storageDir);
		// Reading the storage root (a directory) raises EISDIR, not ENOENT —
		// it must propagate as-is, not get masked as StorageNotFoundError.
		await expect(storage.read(storageDir)).rejects.not.toBeInstanceOf(StorageNotFoundError);
	});

	it("readChunk re-throws non-ENOENT filesystem errors", async () => {
		const storage = new LocalStorage(storageDir);
		await storage.saveChunk("eisdir-note", 0, Buffer.from("anchor"));
		// Make chunk index 1 a directory so readFile returns EISDIR.
		const { mkdir } = await import("node:fs/promises");
		await mkdir(`${storageDir}/eisdir-note/chunk_1`, { recursive: true });
		await expect(storage.readChunk("eisdir-note", 1)).rejects.not.toBeInstanceOf(
			StorageNotFoundError,
		);
	});

	it("rejects negative chunk index in saveChunk/readChunk", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.saveChunk("note1", -1, Buffer.from("x"))).rejects.toBeInstanceOf(
			StorageInvalidKeyError,
		);
		await expect(storage.readChunk("note1", -1)).rejects.toBeInstanceOf(StorageInvalidKeyError);
	});

	it("rejects non-integer chunk index", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.saveChunk("note1", 1.5, Buffer.from("x"))).rejects.toBeInstanceOf(
			StorageInvalidKeyError,
		);
	});

	it("rejects negative chunk count in deleteChunks", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.deleteChunks("note1", -1)).rejects.toBeInstanceOf(StorageInvalidKeyError);
	});
});
