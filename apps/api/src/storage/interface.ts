export interface StorageBackend {
	save(noteId: string, data: Buffer): Promise<string>;
	read(storageKey: string): Promise<Buffer>;
	delete(storageKey: string): Promise<void>;
}
