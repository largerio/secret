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

export function assertChunkIndex(index: number): void {
	if (!Number.isInteger(index) || index < 0) {
		throw new StorageInvalidKeyError("Invalid chunk index");
	}
}

export function assertChunkCount(count: number): void {
	if (!Number.isInteger(count) || count < 0) {
		throw new StorageInvalidKeyError("Invalid chunk count");
	}
}
