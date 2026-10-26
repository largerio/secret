import { constants, mkdirSync } from "node:fs";
import { access, mkdir, opendir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isValidNoteId } from "@largerio/secret-shared";
import {
	assertChunkIndex,
	assertId,
	StorageInvalidKeyError,
	StorageNotFoundError,
} from "./errors.js";
import type { StorageBackend, StoredNote } from "./interface.js";

// A dot can never start a note id, so this directory never reads as a note.
const CLAIMS_DIR = ".instances";

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

	async probe(): Promise<void> {
		// Write access, not just existence: a full disk or a volume remounted
		// read-only is exactly the failure the health endpoint must surface.
		await access(this.filesPath, constants.W_OK);
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

	async purge(noteId: string): Promise<void> {
		assertId(noteId);
		// A file note is one file and a chunked note one directory, both named
		// after the id. `force` makes a missing entry a success; any other
		// failure (permissions, I/O) rejects.
		await rm(this.assertSafePath(join(this.filesPath, noteId)), { recursive: true, force: true });
	}

	async *list(): AsyncIterable<StoredNote> {
		for await (const entry of await opendir(this.filesPath)) {
			if (!isValidNoteId(entry.name)) {
				continue;
			}
			let lastModified: Date;
			try {
				// A directory's mtime moves with every chunk written into it.
				lastModified = (await stat(join(this.filesPath, entry.name))).mtime;
			} catch (err) {
				// Purged since the directory was read.
				if (isNodeError(err) && err.code === "ENOENT") {
					continue;
				}
				throw err;
			}
			yield { noteId: entry.name, lastModified };
		}
	}

	async claim(instanceId: string): Promise<void> {
		assertId(instanceId);
		const claimsPath = join(this.filesPath, CLAIMS_DIR);
		await mkdir(claimsPath, { recursive: true, mode: 0o700 });
		await writeFile(join(claimsPath, instanceId), "", { mode: 0o600 });
	}

	async listClaims(): Promise<string[]> {
		try {
			const entries = await readdir(join(this.filesPath, CLAIMS_DIR));
			// Instance ids never start with a dot; a .DS_Store or the like is no claim.
			return entries.filter((entry) => !entry.startsWith("."));
		} catch (err) {
			if (isNodeError(err) && err.code === "ENOENT") {
				return [];
			}
			throw err;
		}
	}
}
