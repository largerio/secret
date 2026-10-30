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

/**
 * A real backend whose first chunk write, its bytes stored, waits for
 * `release()` before it answers: the moment the chunk is in the storage and
 * its size not yet recorded. `written` resolves then.
 */
export function holdFirstChunkWrite(storage: StorageBackend) {
	const written = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let writes = 0;
	return {
		storage: overrideStorage(storage, {
			saveChunk: async (noteId, index, data) => {
				const key = await storage.saveChunk(noteId, index, data);
				writes += 1;
				if (writes === 1) {
					written.resolve();
					await released.promise;
				}
				return key;
			},
		}),
		written: written.promise,
		release: () => released.resolve(),
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
		// Only when the backend has them: a missing probe means healthy.
		...(storage.probe ? { probe: async () => await storage.probe?.() } : {}),
		...(storage.close ? { close: async () => await storage.close?.() } : {}),
		...overrides,
	};
}
