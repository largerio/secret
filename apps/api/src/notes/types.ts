/** What a writer declares about a note besides its ciphertext. */
export interface NoteSettings {
	readonly clientNonce: string;
	readonly hasPassword: boolean;
	readonly expiresIn: number;
	readonly maxReads: number;
	readonly fileCount: number;
	readonly salt?: string | undefined;
}

export interface UploadSettings extends NoteSettings {
	readonly streamHeader: string;
	readonly chunkCount: number;
}

export interface CreatedNote {
	readonly id: string;
	readonly expiresAt: Date;
	readonly deleteToken: string;
}

/** What anyone with the id learns before opening a note: no read is spent. */
export interface NoteInfo {
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly expiresAt: Date;
	readonly maxReads: number;
	readonly readCount: number;
	readonly chunked: boolean;
}

/** What comes with a note's ciphertext when it is read. */
export interface NoteMeta {
	readonly clientNonce: string;
	readonly hasPassword: boolean;
	readonly salt: string | null;
	readonly fileCount: number;
	readonly createdAt: Date;
	readonly expiresAt: Date;
}

export interface NoteRead {
	readonly meta: NoteMeta;
	/** The client's ciphertext, the server's layer removed. */
	readonly ciphertext: Buffer;
}

export interface NoteStream {
	readonly meta: NoteMeta;
	readonly streamHeader: string;
	readonly chunkCount: number;
	/** The client's chunks, in order, the server's layer removed. */
	readonly chunks: ReadableStream<Uint8Array>;
}

export interface UploadSession {
	readonly uploadId: string;
	readonly expiresAt: Date;
}

/** One chunk arriving for an upload session. */
export interface IncomingChunk {
	readonly uploadId: string;
	readonly index: number;
	/** Lower-case hex SHA-256 the client gave for the chunk. */
	readonly hash: string;
	/**
	 * Reads the chunk itself. Called once the session and the index are
	 * known to be valid, so a refused request is answered before its body is
	 * read.
	 */
	readonly readBody: () => Promise<ArrayBuffer>;
}
