import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	assertChunkCount,
	assertChunkIndex,
	StorageInvalidKeyError,
	StorageNotFoundError,
} from "./errors.js";
import type { StorageBackend } from "./interface.js";

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return Error.isError(err) && typeof (err as NodeJS.ErrnoException).code === "string";
}

export class LocalStorage implements StorageBackend {
	private readonly filesPath: string;

	constructor(filesPath: string) {
		this.filesPath = resolve(filesPath);
		mkdirSync(this.filesPath, { recursive: true, mode: 0o700 });
	}

	private assertSafePath(filePath: string): string {
		const resolved = resolve(filePath);
		if (resolved !== this.filesPath && !resolved.startsWith(`${this.filesPath}/`)) {
			throw new StorageInvalidKeyError("Path traversal detected");
		}
		return resolved;
	}

	async save(noteId: string, data: Buffer): Promise<string> {
		const filePath = this.assertSafePath(join(this.filesPath, noteId));
		await writeFile(filePath, data, { mode: 0o600 });
		return filePath;
	}

	async read(storageKey: string): Promise<Buffer> {
		const safePath = this.assertSafePath(storageKey);
		try {
			return await readFile(safePath);
		} catch (err) {
			if (isNodeError(err) && err.code === "ENOENT") {
				throw new StorageNotFoundError();
			}
			throw err;
		}
	}

	async delete(storageKey: string): Promise<void> {
		try {
			const safePath = this.assertSafePath(storageKey);
			await unlink(safePath);
		} catch {
			/* file already deleted or missing */
		}
	}

	async saveChunk(noteId: string, chunkIndex: number, data: Buffer): Promise<string> {
		assertChunkIndex(chunkIndex);
		const dirPath = this.assertSafePath(join(this.filesPath, noteId));
		await mkdir(dirPath, { recursive: true, mode: 0o700 });
		const filePath = this.assertSafePath(join(dirPath, `chunk_${String(chunkIndex)}`));
		await writeFile(filePath, data, { mode: 0o600 });
		return filePath;
	}

	async readChunk(noteId: string, chunkIndex: number): Promise<Buffer> {
		assertChunkIndex(chunkIndex);
		const filePath = this.assertSafePath(
			join(this.filesPath, noteId, `chunk_${String(chunkIndex)}`),
		);
		try {
			return await readFile(filePath);
		} catch (err) {
			if (isNodeError(err) && err.code === "ENOENT") {
				throw new StorageNotFoundError();
			}
			throw err;
		}
	}

	async deleteChunks(noteId: string, chunkCount: number): Promise<void> {
		assertChunkCount(chunkCount);
		// All chunks of a note live under its own directory, so a single
		// recursive removal replaces per-chunk unlink round-trips.
		const dirPath = this.assertSafePath(join(this.filesPath, noteId));
		try {
			await rm(dirPath, { recursive: true });
		} catch {
			/* directory already deleted or missing */
		}
	}
}
