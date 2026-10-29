import type {
	ChunkedOpening,
	CreatedNote,
	NoteMeta,
	NoteRead,
	NoteStream,
} from "../../notes/types.js";

/** The body of a 201 to a note created, single-shot or chunked. */
export function createdBody(created: CreatedNote) {
	return {
		id: created.id,
		expiresAt: created.expiresAt.toISOString(),
		deleteToken: created.deleteToken,
	};
}

/**
 * A single-shot note's ciphertext as a binary body, its metadata in headers:
 * the answer of `GET /notes/{id}/raw`, and of a format 1 read of such a note.
 */
export function rawResponse({ meta, ciphertext }: NoteRead): Response {
	return new Response(new Uint8Array(ciphertext) as BodyInit, {
		status: 200,
		headers: rawHeaders(meta, ciphertext.length),
	});
}

/**
 * A chunked note's chunks, length-prefixed, its metadata in headers: the
 * answer of `GET /notes/{id}/stream`, and of a format 1 read of such a note.
 */
export function streamResponse({ meta, chunkCount, chunks }: NoteStream): Response {
	return new Response(lengthPrefixed(chunks) as BodyInit, {
		status: 200,
		headers: streamHeaders(meta, chunkCount),
	});
}

/** Strip CRLF and null bytes to prevent HTTP header injection */
function sanitizeHeaderValue(value: string): string {
	return value.replace(/[\r\n\0]/g, "");
}

/** The headers of a single-shot note's ciphertext, `length` bytes. */
function rawHeaders(meta: NoteMeta, length: number): Record<string, string> {
	const headers = buildNoteHeaders(meta);
	headers["Content-Length"] = String(length);
	if (meta.opening.format === 0) {
		headers["X-Client-Nonce"] = sanitizeHeaderValue(meta.opening.clientNonce);
	}
	return headers;
}

/** The headers of a chunked note's stream. */
function streamHeaders(meta: NoteMeta<ChunkedOpening>, chunkCount: number): Record<string, string> {
	const headers = buildNoteHeaders(meta);
	headers["X-Chunk-Count"] = String(chunkCount);
	if (meta.opening.format === 0) {
		headers["X-Stream-Header"] = sanitizeHeaderValue(meta.opening.streamHeader);
	}
	return headers;
}

/**
 * Response headers shared by the encrypted-blob downloads: the note's metadata,
 * and for format 0 the salt, but not the nonce or stream header, which each
 * endpoint adds. A format 1 reader has everything else in the envelope it was
 * served before it proved anything (`/exists`). User-controlled values are
 * sanitized to prevent HTTP header injection.
 */
function buildNoteHeaders(meta: NoteMeta): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/octet-stream",
		// Force a download and forbid MIME sniffing so the still-encrypted blob
		// is never interpreted/executed in a browser context (defense in depth;
		// the global security middleware also sets nosniff).
		"Content-Disposition": "attachment",
		"X-Content-Type-Options": "nosniff",
		// A 200 without cache directives is heuristically cacheable (RFC 9111
		// §4.2.2), so a CDN or the browser cache could replay a burn-after-read
		// note after the row is gone. The global no-store middleware covers this
		// too; repeated here because these headers bypass c.json().
		"Cache-Control": "no-store",
		"X-Has-Password": String(meta.hasPassword),
		"X-File-Count": String(meta.fileCount),
		"X-Created-At": meta.createdAt.toISOString(),
		"X-Expires-At": meta.expiresAt.toISOString(),
	};
	const { opening } = meta;
	if (opening.format === 0 && opening.salt) {
		headers["X-Salt"] = sanitizeHeaderValue(opening.salt);
	}
	return headers;
}

/**
 * The framing of a chunked note's stream: each chunk preceded by its length,
 * 4 bytes big-endian (PROTOCOL.md). It pulls from the source a chunk at a time,
 * as the client reads; a cancel waits for the source's own, which runs the
 * purge of a burned note.
 */
function lengthPrefixed(chunks: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = chunks.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			const length = Buffer.alloc(4);
			length.writeUInt32BE(value.length);
			controller.enqueue(new Uint8Array(length));
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}
