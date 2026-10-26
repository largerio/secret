/** A note that has something stored, as a backend lists it. */
export interface StoredNote {
	readonly noteId: string;
	/** The latest write among the note's objects. */
	readonly lastModified: Date;
}

export interface StorageBackend {
	save(noteId: string, data: Buffer): Promise<string>;
	read(storageKey: string): Promise<Buffer>;
	saveChunk(noteId: string, chunkIndex: number, data: Buffer): Promise<string>;
	readChunk(noteId: string, chunkIndex: number): Promise<Buffer>;
	/**
	 * Remove everything stored under a note id, file or chunks. Nothing left to
	 * remove is a success; any other failure rejects, so the caller can retry.
	 */
	purge(noteId: string): Promise<void>;
	/**
	 * Every note id with something stored. Entries outside the layout this
	 * backend writes are skipped, never reported.
	 */
	list(): AsyncIterable<StoredNote>;
	/** Record that the database of `instanceId` keeps its notes here. */
	claim(instanceId: string): Promise<void>;
	/** Every instance id recorded by `claim`. */
	listClaims(): Promise<string[]>;
	/**
	 * Verify the backend is reachable and writable. Rejects when it is not.
	 * Called by the health endpoint; a backend that omits it is assumed healthy.
	 */
	probe?(): Promise<void>;
	/**
	 * Release any held resources (network clients, handles). Called on shutdown.
	 * Optional: backends without long-lived resources may omit it.
	 */
	close?(): Promise<void>;
}
