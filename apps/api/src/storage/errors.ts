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
