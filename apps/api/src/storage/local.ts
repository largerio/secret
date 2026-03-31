import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { StorageBackend } from "./interface.js";

export class LocalStorage implements StorageBackend {
	private readonly filesPath: string;

	constructor(filesPath: string) {
		this.filesPath = filesPath;
		mkdirSync(filesPath, { recursive: true });
	}

	async save(noteId: string, data: Buffer): Promise<string> {
		const filePath = join(this.filesPath, noteId);
		writeFileSync(filePath, data, { mode: 0o600 });
		return filePath;
	}

	async read(storageKey: string): Promise<Buffer> {
		return readFileSync(storageKey);
	}

	async delete(storageKey: string): Promise<void> {
		try {
			unlinkSync(storageKey);
		} catch {
			/* file already deleted or missing */
		}
	}
}
