import type { ContentMode } from "@largerio/secret-shared";

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
	 * Number of retries for idempotent requests (reads + chunk PUTs) on network
	 * errors, timeouts, and 5xx responses. Default: 0 (no retry). E.g. 2 = up to
	 * 3 attempts total. Note creation/deletion are never retried (non-idempotent).
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
}

export interface CreateNoteResult {
	readonly id: string;
	readonly expiresAt: string;
	readonly deleteToken: string;
	/** Base64url-encoded encryption key for the URL fragment. */
	readonly keyFragment: string;
}

export interface ReadNoteOptions {
	readonly password?: string;
	/** Download progress callback (0 to 1). */
	readonly onDownloadProgress?: (progress: number) => void;
	/** Structured progress callback with phase info. */
	readonly onProgress?: (info: ProgressInfo) => void;
	/** Hint from checkNote: true = chunked (stream), false = standard (raw). Skips trial-and-error. */
	readonly chunked?: boolean;
}

export interface ReadNoteResult {
	readonly payload: import("@largerio/secret-shared").NotePayload;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly fileCount: number;
}

export interface NoteInfo {
	readonly exists: boolean;
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly expiresAt: string;
	readonly maxReads: number;
	readonly chunked: boolean;
}
