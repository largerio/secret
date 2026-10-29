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

/** A chunked format 0 note's, whose stream header comes apart. */
export type ChunkedFormat0Opening = Format0Opening & { readonly streamHeader: string };

/** A chunked note's: format 0 has its stream header apart, format 1 in its envelope. */
export type ChunkedOpening = ChunkedFormat0Opening | Format1Opening;

/**
 * What a format 1 writer sends beside its envelope (PROTOCOL.md): SHA-256 of
 * each proof its readers will send. The server never keeps them as they came:
 * see SealedVerifier.
 */
export interface ReadVerifiers {
	readonly link: Uint8Array;
	/** A password note's. */
	readonly password?: Uint8Array | undefined;
}

/** Which proof a verifier checks: the link's, or the password's. */
export type VerifierRole = keyof ReadVerifiers;

declare const sealed: unique symbol;

/**
 * A verifier as the server keeps it, sealed under its key and bound to its
 * role, the note's id and its envelope (serverLayer.ts). Branded, so that a
 * writer's verifier is never stored, nor checked against, as one.
 */
export type SealedVerifier = Buffer & { readonly [sealed]: true };

/** A format 1 note's verifiers as its row and its upload session keep them. */
export interface SealedVerifiers {
	readonly link: SealedVerifier;
	/** A password note's. */
	readonly password?: SealedVerifier | undefined;
}

/** What a writer declares about a note besides its ciphertext. */
export interface NoteSettings<
	Opening extends NoteOpening = NoteOpening,
	Verifiers extends ReadVerifiers | SealedVerifiers = ReadVerifiers,
> {
	readonly hasPassword: boolean;
	readonly expiresIn: number;
	readonly maxReads: number;
	readonly fileCount: number;
	readonly opening: Opening;
	/** A format 1 note's, which its readers' proofs are checked against. Format 0 has none. */
	readonly verifiers?: Verifiers | undefined;
}

/** A note's settings as its row records them: its verifiers sealed with its id and envelope. */
export type StoredSettings<Opening extends NoteOpening = NoteOpening> = NoteSettings<
	Opening,
	SealedVerifiers
>;

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
	/** A format 1 note's envelope, which its readers derive their proofs with. */
	readonly envelope?: Buffer | undefined;
	/** A format 1 password note's: wrong passwords it still takes, the last of which deletes it. */
	readonly passwordAttemptsLeft?: number | undefined;
}

/** What comes with a note's ciphertext when it is read. */
export interface NoteMeta<Opening extends NoteOpening = NoteOpening> {
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly createdAt: Date;
	readonly expiresAt: Date;
	readonly opening: Opening;
}

export interface NoteRead<Opening extends NoteOpening = NoteOpening> {
	readonly meta: NoteMeta<Opening>;
	/** The client's ciphertext, the server's layer removed. */
	readonly ciphertext: Buffer;
}

export interface NoteStream<Opening extends ChunkedOpening = ChunkedOpening> {
	readonly meta: NoteMeta<Opening>;
	readonly chunkCount: number;
	/** The client's chunks, in order, the server's layer removed. */
	readonly chunks: ReadableStream<Uint8Array>;
}

/** What a format 1 reader sends to be served (PROTOCOL.md): the proofs of its link and password. */
export interface ReadProofs {
	readonly linkProof: Uint8Array;
	/** A password note's: ignored on a note without one. */
	readonly passwordProof?: Uint8Array | undefined;
}

/** A format 1 note served once its proofs checked out, of the kind its envelope names. */
export type ProvenRead =
	| ({ readonly kind: "single-shot" } & NoteRead<Format1Opening>)
	| ({ readonly kind: "chunked" } & NoteStream<Format1Opening>);

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
