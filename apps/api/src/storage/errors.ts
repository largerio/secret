// Typed errors emitted by StorageBackend implementations so routes can map
// them to HTTP responses without string-matching.
export class StorageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageError";
	}
}

export class StorageInvalidKeyError extends StorageError {
	constructor(message = "Invalid storage key") {
		super(message);
		this.name = "StorageInvalidKeyError";
	}
}

export class StorageNotFoundError extends StorageError {
	constructor(message = "Storage object not found") {
		super(message);
		this.name = "StorageNotFoundError";
	}
}

/**
 * What a log line may say about a storage failure. A filesystem error's message
 * names the path, which holds the note id, and an S3 server may quote the key:
 * only the code (or the error's name) goes out. This module's own errors are
 * worded without either, so they keep their message.
 */
export function describeStorageError(err: unknown): string {
	if (err instanceof StorageError) {
		return err.message;
	}
	if (Error.isError(err)) {
		const { code } = err as { code?: unknown };
		return typeof code === "string" ? code : err.name;
	}
	return typeof err;
}

// Note ids and instance ids are both nanoids: this charset keeps them from
// ever addressing a path or key outside their own.
const ID_RE = /^[A-Za-z0-9_-]+$/;

export function assertId(id: string): void {
	if (!ID_RE.test(id)) {
		throw new StorageInvalidKeyError("Invalid id for storage key");
	}
}

export function assertChunkIndex(index: number): void {
	if (!Number.isInteger(index) || index < 0) {
		throw new StorageInvalidKeyError("Invalid chunk index");
	}
}
