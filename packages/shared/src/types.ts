export interface NotePayload {
	readonly text?: string;
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
	readonly burnAfterRead: boolean;
	readonly expiresIn: number;
	readonly maxReads?: number;
	readonly fileCount: number;
}

export interface CreateNoteResponse {
	readonly id: string;
	readonly expiresAt: string;
}

export interface NoteExistsResponse {
	readonly exists: boolean;
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly expiresAt: string;
	readonly burnAfterRead: boolean;
}

export interface ReadNoteResponse {
	readonly encryptedData: string;
	readonly clientNonce: string;
	readonly hasPassword: boolean;
	readonly fileCount: number;
	readonly createdAt: string;
	readonly expiresAt: string;
}

export type ExpirationOption = (typeof EXPIRATION_OPTIONS)[number];

export const EXPIRATION_OPTIONS = [
	{ label: "5 minutes", value: 300 },
	{ label: "1 hour", value: 3600 },
	{ label: "24 hours", value: 86400 },
	{ label: "7 days", value: 604800 },
	{ label: "30 days", value: 2592000 },
] as const;
