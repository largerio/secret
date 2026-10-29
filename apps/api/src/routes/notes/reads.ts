import type { OpenAPIHono } from "@hono/zod-openapi";
import type { NotesService } from "../../notes/service.js";
import { existsRoute, rawNoteRoute, readNoteRoute, streamNoteRoute } from "./openapi-routes.js";
import { buildNoteHeaders, lengthPrefixed, sanitizeHeaderValue } from "./responses.js";

/** What reads a note: its state, and its ciphertext in one piece or as a stream. */
export function registerReadRoutes(app: OpenAPIHono, notes: NotesService): void {
	app.openapi(existsRoute, (c) => {
		const info = notes.check(c.req.valid("param").id);
		if (info === undefined) {
			return c.json({ exists: false as const });
		}
		// Field by field: what the service learns about a note is not all public.
		return c.json({
			exists: true as const,
			hasPassword: info.hasPassword,
			fileCount: info.fileCount,
			expiresAt: info.expiresAt.toISOString(),
			maxReads: info.maxReads,
			readCount: info.readCount,
			chunked: info.chunked,
		});
	});

	app.openapi(readNoteRoute, async (c) => {
		const { meta, ciphertext } = await notes.read(c.req.valid("param").id);
		return c.json({
			encryptedData: ciphertext.toString("base64"),
			clientNonce: meta.clientNonce,
			hasPassword: meta.hasPassword,
			...(meta.salt ? { salt: meta.salt } : {}),
			fileCount: meta.fileCount,
			createdAt: meta.createdAt.toISOString(),
			expiresAt: meta.expiresAt.toISOString(),
		});
	});

	app.openapi(rawNoteRoute, async (c) => {
		const { meta, ciphertext } = await notes.read(c.req.valid("param").id);
		const headers = buildNoteHeaders(meta);
		headers["Content-Length"] = String(ciphertext.length);
		headers["X-Client-Nonce"] = sanitizeHeaderValue(meta.clientNonce);
		return new Response(new Uint8Array(ciphertext) as BodyInit, { status: 200, headers });
	});

	app.openapi(streamNoteRoute, async (c) => {
		const { meta, streamHeader, chunkCount, chunks } = await notes.stream(c.req.valid("param").id);
		const headers = buildNoteHeaders(meta);
		headers["X-Stream-Header"] = sanitizeHeaderValue(streamHeader);
		headers["X-Chunk-Count"] = String(chunkCount);
		return new Response(lengthPrefixed(chunks) as BodyInit, { status: 200, headers });
	});
}
