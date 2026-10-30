/**
 * Payload types are declared here rather than re-exported from
 * `@largerio/secret-shared`, which is a private workspace package that is never
 * published: a generated `.d.ts` pointing at it left every TypeScript consumer
 * with TS2307. `payload-contract.test.ts` asserts these stay structurally
 * identical to the shared definitions, so a divergence fails the build.
 */

/** How the note body should be interpreted once decrypted. */
export type ContentMode = "text" | "markdown" | "secret";

/** A file carried inside an encrypted note payload. */
export interface NoteFile {
	readonly name: string;
	readonly type: string;
	readonly size: number;
	readonly data: Uint8Array;
}

/** The decrypted contents of a note. */
export interface NotePayload {
	readonly text?: string;
	readonly contentMode?: ContentMode;
	readonly files?: ReadonlyArray<NoteFile>;
}

export type UploadPhase = "encrypting" | "uploading" | "processing";
export type DownloadPhase = "downloading" | "decrypting";

export interface ProgressInfo {
	readonly phase: UploadPhase | DownloadPhase;
	readonly phaseProgress: number;
	readonly overallProgress: number;
	readonly currentChunk?: number;
	readonly totalChunks?: number;
}

export interface SecretClientConfig {
	/** Base URL of the Secret instance. Defaults to "" (relative URLs for browser). */
	readonly baseUrl?: string;
	/** Custom fetch implementation. Defaults to globalThis.fetch. */
	readonly fetch?: typeof fetch;
	/** Optional API key for authenticated instances. Sent as Bearer token. */
	readonly apiKey?: string;
	/** Per-request timeout in ms. Default: none (no timeout). */
	readonly timeoutMs?: number;
	/**
	 * Number of retries for idempotent requests (`checkNote` + chunk PUTs) on
	 * network errors, timeouts, and 5xx responses. Default: 0 (no retry). E.g.
	 * 2 = up to 3 attempts total. Note creation, deletion and reads are never
	 * retried: a read spends one of the note's reads as soon as it is served.
	 */
	readonly maxRetries?: number;
	/** Backoff (ms) before retry attempt N (1-based). Default: 2**N * 250. */
	readonly retryBackoffMs?: (attempt: number) => number;
}

export interface CreateNoteOptions {
	readonly text?: string;
	readonly contentMode?: ContentMode;
	readonly files?: ReadonlyArray<{
		readonly name: string;
		readonly type: string;
		readonly data: Uint8Array;
	}>;
	readonly password?: string;
	/** Expiration in seconds. Default: 86400 (24h). */
	readonly expiresIn?: number;
	/** Max reads before auto-delete. 0 = unlimited. Default: 1. */
	readonly maxReads?: number;
	/** Upload progress callback (0 to 1). Browser-only for multipart uploads. */
	readonly onUploadProgress?: (progress: number) => void;
	/** Structured progress callback with phase info. */
	readonly onProgress?: (info: ProgressInfo) => void;
	/** PoW token from Cap widget. Required for browser clients without API key. */
	readonly capToken?: string;
	/** Force chunked upload mode. Auto-detected when payload exceeds chunkSize. */
	readonly chunked?: boolean;
	/** Chunk size in bytes for chunked upload. Default: 4MB (DEFAULT_CHUNK_SIZE). */
	readonly chunkSize?: number;
	/**
	 * The encryption format to write (PROTOCOL.md): 0 or 1. Default: 1, which
	 * pads the note and is read with a proof of the link and the password. Pass
	 * 0 for an instance older than 1.6.0, which refuses format 1, or for readers
	 * on an SDK older than 1.3.0. Reads take either, from the link.
	 */
	readonly format?: 0 | 1;
}

export interface CreateNoteResult {
	readonly id: string;
	readonly expiresAt: string;
	readonly deleteToken: string;
	/**
	 * The URL fragment: the key in base64url, after `1.` for a format 1 note.
	 */
	readonly keyFragment: string;
}

export interface ReadNoteOptions {
	readonly password?: string;
	/** Download progress callback (0 to 1). */
	readonly onDownloadProgress?: (progress: number) => void;
	/** Structured progress callback with phase info. */
	readonly onProgress?: (info: ProgressInfo) => void;
	/**
	 * Hint from checkNote for a format 0 note: true = chunked (stream), false =
	 * standard (raw). Skips trial-and-error. A format 1 read ignores it: every
	 * format 1 note is read the same way.
	 */
	readonly chunked?: boolean;
}

export interface ReadNoteResult {
	readonly payload: NotePayload;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly fileCount: number;
}

/** Metadata about an existing note, as reported by `checkNote`. */
export interface ExistingNoteInfo {
	readonly exists: true;
	/** Whether a password is required in addition to the key fragment. */
	readonly hasPassword: boolean;
	readonly fileCount: number;
	/** ISO 8601 timestamp. */
	readonly expiresAt: string;
	/** Configured read limit (0 means unlimited) — not the remaining count. */
	readonly maxReads: number;
	/**
	 * Reads already spent: reads left is `maxReads - readCount`. On a format 0
	 * note, wrong passwords count too. Always 0 when `maxReads` is 0. Absent
	 * when the instance runs an API older than this field.
	 */
	readonly readCount?: number;
	/** Whether the note must be read through the streaming endpoint. */
	readonly chunked: boolean;
	/**
	 * A format 1 note's envelope, in base64 (PROTOCOL.md): what a reader derives
	 * its proofs with. Absent for a format 0 note.
	 */
	readonly envelope?: string;
	/**
	 * A format 1 password note's: wrong passwords it still takes, the last of
	 * which deletes it. A wrong password spends no read of a format 1 note.
	 */
	readonly passwordAttemptsLeft?: number;
}

/**
 * A discriminated union: the API returns only `{exists: false}` for a missing
 * note, so declaring the other fields as always-present made the type lie —
 * callers reading `info.maxReads` on a missing note silently got `undefined`.
 * Narrow on `exists` before touching anything else.
 */
export type NoteInfo = ExistingNoteInfo | { readonly exists: false };
