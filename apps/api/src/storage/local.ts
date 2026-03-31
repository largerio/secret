import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StorageBackend } from "./interface.js";

export class LocalStorage implements StorageBackend {
	private readonly filesPath: string;

	constructor(filesPath: string) {
		this.filesPath = resolve(filesPath);
		mkdirSync(this.filesPath, { recursive: true, mode: 0o700 });
	}

	private assertSafePath(filePath: string): string {
		const resolved = resolve(filePath);
		if (resolved !== this.filesPath && !resolved.startsWith(`${this.filesPath}/`)) {
			throw new Error("Path traversal detected");
		}
		return resolved;
	}

	async save(noteId: string, data: Buffer): Promise<string> {
		const filePath = this.assertSafePath(join(this.filesPath, noteId));
		writeFileSync(filePath, data, { mode: 0o600 });
		return filePath;
	}

	async read(storageKey: string): Promise<Buffer> {
		const safePath = this.assertSafePath(storageKey);
		return readFileSync(safePath);
	}

	async delete(storageKey: string): Promise<void> {
		try {
			const safePath = this.assertSafePath(storageKey);
			unlinkSync(safePath);
		} catch {
			/* file already deleted or missing */
		}
	}
}
