export interface StorageBackend {
	save(noteId: string, data: Buffer): Promise<string>;
	read(storageKey: string): Promise<Buffer>;
	delete(storageKey: string): Promise<void>;
	saveChunk(noteId: string, chunkIndex: number, data: Buffer): Promise<string>;
	readChunk(noteId: string, chunkIndex: number): Promise<Buffer>;
	deleteChunks(noteId: string, chunkCount: number): Promise<void>;
	/**
	 * Release any held resources (network clients, handles). Called on shutdown.
	 * Optional: backends without long-lived resources may omit it.
	 */
	close?(): Promise<void>;
}
