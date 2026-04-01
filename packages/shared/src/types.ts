export type ContentMode = "text" | "markdown" | "secret";

export interface NotePayload {
	readonly text?: string;
	readonly contentMode?: ContentMode;
	readonly files?: ReadonlyArray<NoteFile>;
}

export interface NoteFile {
	readonly name: string;
	readonly type: string;
	readonly size: number;
	readonly data: Uint8Array;
}

export interface CreateNoteRequest {
	readonly encryptedData: string;
	readonly clientNonce: string;
	readonly hasPassword: boolean;
	readonly expiresIn: number;
	readonly maxReads: number;
	readonly fileCount: number;
	readonly salt?: string;
}

export interface CreateNoteResponse {
	readonly id: string;
	readonly expiresAt: string;
	readonly deleteToken: string;
}

export interface NoteExistsResponse {
	readonly exists: boolean;
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly expiresAt: string;
	readonly maxReads: number;
}

export interface ReadNoteResponse {
	readonly encryptedData: string;
	readonly clientNonce: string;
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly salt?: string;
}

// Chunked upload types
export interface ChunkedUploadInitRequest {
	readonly streamHeader: string;
	readonly clientNonce: string;
	readonly hasPassword: boolean;
	readonly expiresIn: number;
	readonly maxReads: number;
	readonly fileCount: number;
	readonly chunkCount: number;
	readonly salt?: string;
}

export interface ChunkedUploadInitResponse {
	readonly uploadId: string;
	readonly expiresAt: string;
}

export interface ChunkUploadResponse {
	readonly received: true;
}

export interface ChunkedUploadCompleteResponse {
	readonly id: string;
	readonly expiresAt: string;
	readonly deleteToken: string;
}

export interface ServerConfig {
	readonly appName: string;
	readonly appDescription: string;
	readonly appUrl: string;
	readonly primaryColor: string;
	readonly footerText: string;
	readonly ogImageUrl: string;
	readonly maxFileSize: number;
	readonly maxFilesPerNote: number;
	readonly storageType: "local" | "s3";
}

export type ExpirationOption = (typeof EXPIRATION_OPTIONS)[number];

export const EXPIRATION_OPTIONS = [
	{ label: "5 minutes", labelKey: "expiry_5min", value: 300 },
	{ label: "1 hour", labelKey: "expiry_1h", value: 3600 },
	{ label: "24 hours", labelKey: "expiry_24h", value: 86400 },
	{ label: "7 days", labelKey: "expiry_7d", value: 604800 },
	{ label: "30 days", labelKey: "expiry_30d", value: 2592000 },
] as const;
