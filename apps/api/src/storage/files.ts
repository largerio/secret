import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function ensureFilesDir(filesPath: string): void {
	mkdirSync(filesPath, { recursive: true });
}

export function saveFile(filesPath: string, noteId: string, data: Buffer): string {
	ensureFilesDir(filesPath);
	const filePath = join(filesPath, noteId);
	writeFileSync(filePath, data, { mode: 0o600 });
	return filePath;
}

export function readFile(filePath: string): Buffer {
	return readFileSync(filePath);
}

export function deleteFile(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* file already deleted or missing — safe to ignore */
	}
}
