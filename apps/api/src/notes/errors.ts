/**
 * Why a notes operation refused. The service knows nothing of HTTP: the
 * routes map each code to a status (routes/notes/errorStatus.ts).
 */
export type NoteErrorCode =
	/** No note by that id: never created, expired, burned or deleted. */
	| "note_not_found"
	/** A single-shot read was asked of a chunked note. */
	| "note_is_chunked"
	/** A stream was asked of a single-shot note. */
	| "note_is_single_shot"
	/**
	 * A read was asked of a note in a format its answer cannot carry: the
	 * legacy JSON read, of a format 1 note.
	 */
	| "note_format_unsupported"
	/** A note without files larger than the database is meant to hold. */
	| "note_too_large"
	/** The stored note does not open: corrupt bytes, or a corrupt row. */
	| "note_corrupted"
	| "expiry_above_limit"
	| "too_many_files"
	| "too_many_chunks"
	| "storage_quota_exceeded"
	| "wrong_delete_token"
	| "upload_not_found"
	| "upload_incomplete"
	/**
	 * The session's note already exists: a chunk that arrived while the
	 * session was completed, or a note id already taken. Completing a session
	 * twice finds no session the second time: upload_not_found.
	 */
	| "upload_already_completed"
	/** The session row no longer parses: a database problem, not the client's. */
	| "upload_corrupted"
	| "chunk_out_of_range"
	| "chunk_empty"
	| "chunk_too_large"
	| "chunk_hash_mismatch";

/** What a client is told, unless the refusal names the limit it hit. */
const MESSAGES: Readonly<Record<NoteErrorCode, string>> = {
	note_not_found: "Note not found",
	note_is_chunked: "Note is chunked: read it as a stream",
	note_is_single_shot: "Note is not a chunked note",
	note_format_unsupported: "Note format not supported here: read it as raw bytes",
	note_too_large: "Payload too large",
	note_corrupted: "Failed to decrypt note",
	expiry_above_limit: "Expiry above the instance's limit",
	too_many_files: "Too many files for the instance",
	too_many_chunks: "Too many chunks for the instance",
	storage_quota_exceeded: "Storage quota exceeded",
	wrong_delete_token: "Invalid delete token",
	upload_not_found: "Upload session not found or expired",
	upload_incomplete: "Upload incomplete",
	upload_already_completed: "Upload already completed",
	upload_corrupted: "Corrupted upload session",
	chunk_out_of_range: "Chunk index out of range",
	chunk_empty: "Empty chunk body",
	chunk_too_large: "Chunk too large",
	chunk_hash_mismatch: "Chunk hash mismatch",
};

/**
 * A refusal from the notes service. Its message is safe to show a client; the
 * cause, when there is one, is for the operator's log only.
 */
export class NoteError extends Error {
	override readonly name = "NoteError";

	constructor(
		readonly code: NoteErrorCode,
		options?: { readonly message?: string; readonly cause?: unknown },
	) {
		super(
			options?.message ?? MESSAGES[code],
			options?.cause === undefined ? undefined : { cause: options.cause },
		);
	}
}
