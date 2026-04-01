import type { ContentMode } from "@secret/shared";

export interface SecretClientConfig {
	/** Base URL of the Secret instance. Defaults to "" (relative URLs for browser). */
	readonly baseUrl?: string;
	/** Custom fetch implementation. Defaults to globalThis.fetch. */
	readonly fetch?: typeof fetch;
	/** Optional API key for authenticated instances. Sent as Bearer token. */
	readonly apiKey?: string;
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
	/** PoW token from Cap widget. Required for browser clients without API key. */
	readonly capToken?: string;
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
}

export interface ReadNoteResult {
	readonly payload: import("@secret/shared").NotePayload;
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
}
