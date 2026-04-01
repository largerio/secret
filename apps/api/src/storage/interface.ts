export interface StorageBackend {
	save(noteId: string, data: Buffer): Promise<string>;
	read(storageKey: string): Promise<Buffer>;
	delete(storageKey: string): Promise<void>;
	saveChunk(noteId: string, chunkIndex: number, data: Buffer): Promise<string>;
	readChunk(noteId: string, chunkIndex: number): Promise<Buffer>;
	deleteChunks(noteId: string, chunkCount: number): Promise<void>;
}
