import {
	type ContentMode,
	type CreateNoteOptions,
	type ProgressInfo,
	SecretApiError,
	SecretDecryptionError,
	SecretNetworkError,
	SecretValidationError,
} from "@largerio/secret-sdk";

/** What a page gives to create a note: the SDK's options, less what cannot cross to a worker. */
export type CreateOptions = Omit<CreateNoteOptions, "onProgress" | "onUploadProgress" | "signal">;

/** What a page asks the worker that encrypts and decrypts notes. */
export type Request =
	| { readonly kind: "create"; readonly call: number; readonly options: CreateOptions }
	| {
			readonly kind: "read";
			readonly call: number;
			readonly id: string;
			readonly keyFragment: string;
			readonly password?: string;
			readonly chunked?: boolean;
			/** The directory the read stages its files in. */
			readonly readId: string;
	  }
	| { readonly kind: "check"; readonly call: number; readonly id: string }
	| {
			readonly kind: "delete";
			readonly call: number;
			readonly id: string;
			readonly deleteToken: string;
			readonly capToken?: string;
	  };

/** What the worker answers: once ready, then each call's progress and its result or error. */
export type Answer =
	| { readonly kind: "ready" }
	| { readonly kind: "progress"; readonly call: number; readonly info: ProgressInfo }
	| { readonly kind: "result"; readonly call: number; readonly value: unknown }
	| { readonly kind: "error"; readonly call: number; readonly error: SentError };

/** A file of a note read, its bytes on disk or in memory, never in an array of the page's. */
export interface OpenedFile {
	readonly name: string;
	readonly type: string;
	readonly size: number;
	readonly data: Blob;
}

/** A note read: its text, and its files. */
export interface ReadResult {
	readonly text?: string;
	readonly contentMode?: ContentMode;
	readonly files: ReadonlyArray<OpenedFile>;
}

/**
 * An error as it crosses from the worker to the page: a structured clone
 * keeps neither an error's class nor its fields, which the pages tell
 * errors apart by.
 */
export type SentError =
	| {
			readonly name: "SecretApiError";
			readonly message: string;
			readonly status: number;
			readonly code?: string;
			readonly retryAfter?: number;
	  }
	| {
			readonly name: "SecretDecryptionError" | "SecretNetworkError" | "SecretValidationError";
			readonly message: string;
	  }
	| { readonly name: "Error"; readonly message: string };

export function sentError(error: unknown): SentError {
	if (error instanceof SecretApiError) {
		return {
			name: "SecretApiError",
			message: error.message,
			status: error.status,
			...(error.code !== undefined ? { code: error.code } : {}),
			...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
		};
	}
	if (error instanceof SecretDecryptionError) {
		return { name: "SecretDecryptionError", message: error.message };
	}
	if (error instanceof SecretNetworkError) {
		return { name: "SecretNetworkError", message: error.message };
	}
	if (error instanceof SecretValidationError) {
		return { name: "SecretValidationError", message: error.message };
	}
	return { name: "Error", message: error instanceof Error ? error.message : String(error) };
}

/** The error a worker sent, of its class again. */
export function receivedError(sent: SentError): Error {
	switch (sent.name) {
		case "SecretApiError":
			return new SecretApiError(sent.message, sent.status, {
				code: sent.code,
				retryAfter: sent.retryAfter,
			});
		case "SecretDecryptionError":
			return new SecretDecryptionError(sent.message);
		case "SecretNetworkError":
			return new SecretNetworkError(sent.message);
		case "SecretValidationError":
			return new SecretValidationError(sent.message);
		default:
			return new Error(sent.message);
	}
}
