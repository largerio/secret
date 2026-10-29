import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { NoteError, type NoteErrorCode } from "../../notes/errors.js";

/** The one place a refusal of the notes service becomes an HTTP status. */
const NOTE_ERROR_STATUS: Readonly<Record<NoteErrorCode, ContentfulStatusCode>> = {
	note_not_found: 404,
	note_is_chunked: 400,
	note_is_single_shot: 400,
	note_format_mismatch: 400,
	wrong_link_proof: 403,
	password_proof_missing: 400,
	wrong_password: 403,
	note_not_padded: 400,
	note_too_large: 413,
	note_corrupted: 500,
	expiry_above_limit: 400,
	too_many_files: 400,
	too_many_chunks: 400,
	// The instance is full, not the request too large: 507, not 413.
	storage_quota_exceeded: 507,
	wrong_delete_token: 403,
	upload_not_found: 404,
	upload_incomplete: 400,
	upload_already_completed: 409,
	upload_corrupted: 500,
	chunk_out_of_range: 400,
	chunk_empty: 400,
	chunk_too_large: 413,
	chunk_hash_mismatch: 400,
};

/**
 * A NoteError as the HTTP error it answers, for the app's error handler, which
 * then treats it like any HTTPException. Anything else is not ours: undefined.
 */
export function noteErrorToHttp(err: Error): HTTPException | undefined {
	if (!(err instanceof NoteError)) {
		return undefined;
	}
	return new HTTPException(NOTE_ERROR_STATUS[err.code], {
		message: err.message,
		...(err.cause !== undefined ? { cause: err.cause } : {}),
	});
}
