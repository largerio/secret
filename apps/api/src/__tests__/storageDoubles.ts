import { vi } from "vitest";
import type { StorageBackend } from "../storage/index.js";

/** A backend of mocks: purges succeed, nothing is listed or claimed. */
export function stubStorage(overrides: Partial<StorageBackend> = {}): StorageBackend {
	return {
		save: vi.fn(),
		read: vi.fn(),
		saveChunk: vi.fn(),
		readChunk: vi.fn(),
		purge: vi.fn().mockResolvedValue(undefined),
		list: vi.fn(async function* () {}),
		claim: vi.fn().mockResolvedValue(undefined),
		listClaims: vi.fn().mockResolvedValue([]),
		...overrides,
	};
}

/** A real backend with some methods replaced, to make it fail on cue. */
export function overrideStorage(
	storage: StorageBackend,
	overrides: Partial<StorageBackend>,
): StorageBackend {
	return {
		save: (noteId, data) => storage.save(noteId, data),
		read: (key) => storage.read(key),
		saveChunk: (noteId, index, data) => storage.saveChunk(noteId, index, data),
		readChunk: (noteId, index) => storage.readChunk(noteId, index),
		purge: (noteId) => storage.purge(noteId),
		list: () => storage.list(),
		claim: (instanceId) => storage.claim(instanceId),
		listClaims: () => storage.listClaims(),
		...overrides,
	};
}
