/** How a reader opens a format 0 note: the fields its writer sent, as they came. */
export interface Format0Opening {
	readonly format: 0;
	readonly clientNonce: string;
	/** A password note's salt. */
	readonly salt?: string | undefined;
	/** A chunked note's secretstream header. */
	readonly streamHeader?: string | undefined;
}

/**
 * How a reader opens a format 1 note: its envelope (PROTOCOL.md), byte for byte
 * as its writer sent it. The ciphertext authenticates it, so the server stores
 * and serves it untouched.
 */
export interface Format1Opening {
	readonly format: 1;
	readonly envelope: Buffer;
}

/** What a note's format needs, besides its ciphertext, for a reader to open it. */
export type NoteOpening = Format0Opening | Format1Opening;

/** A chunked note's: format 0 has its stream header apart, format 1 in its envelope. */
export type ChunkedOpening = (Format0Opening & { readonly streamHeader: string }) | Format1Opening;

export type NoteFormat = NoteOpening["format"];

/** The opening of a note of one of the given formats. */
export type OpeningOf<F extends NoteFormat> = Extract<NoteOpening, { readonly format: F }>;

/** What a writer declares about a note besides its ciphertext. */
export interface NoteSettings<Opening extends NoteOpening = NoteOpening> {
	readonly hasPassword: boolean;
	readonly expiresIn: number;
	readonly maxReads: number;
	readonly fileCount: number;
	readonly opening: Opening;
}

export interface UploadSettings extends NoteSettings<ChunkedOpening> {
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
export interface NoteMeta<Opening extends NoteOpening = NoteOpening> {
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly opening: Opening;
}

export interface NoteRead<F extends NoteFormat = NoteFormat> {
	readonly meta: NoteMeta<OpeningOf<F>>;
	/** The client's ciphertext, the server's layer removed. */
	readonly ciphertext: Buffer;
}

export interface NoteStream {
	readonly meta: NoteMeta<ChunkedOpening>;
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
