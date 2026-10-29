import type { CreatedNote, NoteMeta } from "../../notes/types.js";

/** The body of a 201 to a note created, single-shot or chunked. */
export function createdBody(created: CreatedNote) {
	return {
		id: created.id,
		expiresAt: created.expiresAt.toISOString(),
		deleteToken: created.deleteToken,
	};
}

/** Strip CRLF and null bytes to prevent HTTP header injection */
export function sanitizeHeaderValue(value: string): string {
	return value.replace(/[\r\n\0]/g, "");
}

/**
 * Response headers shared by the encrypted-blob download endpoints (`/raw` and
 * `/stream`). Callers add their own Content-Length and payload-shape headers
 * (e.g. X-Client-Nonce or X-Stream-Header). User-controlled values are
 * sanitized to prevent HTTP header injection.
 */
export function buildNoteHeaders(meta: NoteMeta): Record<string, string> {
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
	if (meta.salt) {
		headers["X-Salt"] = sanitizeHeaderValue(meta.salt);
	}
	return headers;
}

/**
 * The framing of `GET /notes/{id}/stream`: each chunk preceded by its length,
 * 4 bytes big-endian (PROTOCOL.md). It pulls from the source a chunk at a time,
 * as the client reads; a cancel waits for the source's own, which runs the
 * purge of a burned note.
 */
export function lengthPrefixed(chunks: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
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
