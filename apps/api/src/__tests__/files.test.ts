import { existsSync, rmSync } from "node:fs";
import { stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { StorageInvalidKeyError, StorageNotFoundError } from "../storage/errors.js";
import type { StoredNote } from "../storage/interface.js";
import { LocalStorage } from "../storage/local.js";

const TEST_DIR = "./data/fs-test";

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

async function collect(notes: AsyncIterable<StoredNote>): Promise<StoredNote[]> {
	const listed: StoredNote[] = [];
	for await (const note of notes) {
		listed.push(note);
	}
	return listed.sort((a, b) => a.noteId.localeCompare(b.noteId));
}

describe("LocalStorage", () => {
	const storageDir = `${TEST_DIR}/local-storage`;

	it("saves and reads data through the interface", async () => {
		const storage = new LocalStorage(storageDir);
		const data = Buffer.from("local-storage-test");
		const key = await storage.save("ls-test-1", data);
		const read = await storage.read(key);
		expect(read).toEqual(data);
	});

	it("purges a file note", async () => {
		const storage = new LocalStorage(storageDir);
		const key = await storage.save("ls-test-2", Buffer.from("to-delete"));
		expect(existsSync(key)).toBe(true);
		await storage.purge("ls-test-2");
		expect(existsSync(key)).toBe(false);
	});

	it("purges a chunked note, directory included", async () => {
		const storage = new LocalStorage(storageDir);
		const key = await storage.saveChunk("del-chunks-1", 0, Buffer.from("to-delete-0"));
		await storage.saveChunk("del-chunks-1", 1, Buffer.from("to-delete-1"));

		await storage.purge("del-chunks-1");

		expect(existsSync(dirname(key))).toBe(false);
	});

	it("treats purging a note with nothing stored as done", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.purge("nonexistent")).resolves.toBeUndefined();
	});

	it("rejects a purge it cannot carry out, so it gets retried", async () => {
		const brokenDir = `${TEST_DIR}/broken-root`;
		const storage = new LocalStorage(brokenDir);
		// The storage root replaced by a file: no permission bit to bypass, even as root.
		rmSync(brokenDir, { recursive: true });
		await writeFile(brokenDir, "not a directory");

		await expect(storage.purge("some-note")).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	it("rejects a note id that could leave the storage directory", async () => {
		const storage = new LocalStorage(storageDir);
		await expect(storage.purge("../outside")).rejects.toBeInstanceOf(StorageInvalidKeyError);
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
});

describe("LocalStorage listing and claims", () => {
	const storageDir = `${TEST_DIR}/listing`;
	const fileNoteId = "fileNote_001";
	const chunkedNoteId = "chunkNote_01";
	let storage: LocalStorage;

	beforeEach(() => {
		rmSync(storageDir, { recursive: true, force: true });
		storage = new LocalStorage(storageDir);
	});

	it("lists each stored note once, with its last write", async () => {
		await storage.save(fileNoteId, Buffer.from("file"));
		await storage.saveChunk(chunkedNoteId, 0, Buffer.from("c0"));
		await storage.saveChunk(chunkedNoteId, 1, Buffer.from("c1"));
		const written = new Date("2026-01-02T03:04:05Z");
		await utimes(join(storageDir, fileNoteId), written, written);

		const listed = await collect(storage.list());

		expect(listed.map((note) => note.noteId)).toEqual([chunkedNoteId, fileNoteId]);
		expect(listed.find((note) => note.noteId === fileNoteId)?.lastModified).toEqual(written);
	});

	it("skips entries that are not note ids, claims included", async () => {
		await storage.claim("instance-a");
		await writeFile(join(storageDir, "notes.txt"), "not a note");
		await storage.save("short-id", Buffer.from("x"));

		expect(await collect(storage.list())).toEqual([]);
	});

	it("skips an entry purged while the listing runs", async () => {
		// A dangling link stats as missing, like an entry removed after readdir.
		await symlink(resolve(storageDir, "gone"), join(storageDir, "gonePurged01"));

		expect(await collect(storage.list())).toEqual([]);
	});

	it("rejects a listing that cannot read an entry", async () => {
		await symlink("loopEntry_01", join(storageDir, "loopEntry_01"));

		await expect(collect(storage.list())).rejects.toMatchObject({ code: "ELOOP" });
	});

	it("records and lists claims", async () => {
		expect(await storage.listClaims()).toEqual([]);

		await storage.claim("instance-a");
		await storage.claim("instance-a");
		await storage.claim("instance-b");
		await writeFile(join(storageDir, ".instances", ".DS_Store"), "");

		expect((await storage.listClaims()).sort()).toEqual(["instance-a", "instance-b"]);
		expect((await stat(join(storageDir, ".instances", "instance-a"))).mode & 0o777).toBe(0o600);
	});

	it("rejects an instance id that could leave the claims directory", async () => {
		await expect(storage.claim("../note")).rejects.toBeInstanceOf(StorageInvalidKeyError);
	});

	it("rejects a claims listing it cannot read", async () => {
		await writeFile(join(storageDir, ".instances"), "not a directory");

		await expect(storage.listClaims()).rejects.toMatchObject({ code: "ENOTDIR" });
	});
});
