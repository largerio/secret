import type { OpenAPIHono } from "@hono/zod-openapi";
import type { NotesService } from "../../notes/service.js";
import type { NoteFormat } from "../../notes/types.js";
import { existsRoute, rawNoteRoute, readNoteRoute, streamNoteRoute } from "./openapi-routes.js";
import { lengthPrefixed, rawHeaders, streamHeaders } from "./responses.js";

/** The format a binary read asks for: format 1 by name, format 0 without it. */
function askedFormat(query: { readonly format?: "0" | "1" | undefined }): NoteFormat {
	return query.format === "1" ? 1 : 0;
}

/** What reads a note: its state, and its ciphertext in one piece or as a stream. */
export function registerReadRoutes(app: OpenAPIHono, notes: NotesService): void {
	// Hono answers a HEAD with the GET route and drops the body: on the reads
	// that spend, it would spend one, and burn a single-read note, without
	// delivering anything. Registered before the routes, so they never run;
	// for GET alone, which HEAD goes through, so that no other request counts
	// it as its route (`/:id` matches `POST /upload`, and logs and metrics
	// name a request by the last route that matches it).
	for (const path of ["/:id", "/:id/raw", "/:id/stream"]) {
		app.get(path, async (c, next) => {
			if (c.req.method === "HEAD") {
				c.header("Allow", "GET");
				return c.json({ error: "Method not allowed" }, 405);
			}
			await next();
		});
	}

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
		// Its answer has format 0's fields, and no room for an envelope.
		const { meta, ciphertext } = await notes.read(c.req.valid("param").id, 0);
		return c.json({
			encryptedData: ciphertext.toString("base64"),
			clientNonce: meta.opening.clientNonce,
			hasPassword: meta.hasPassword,
			...(meta.opening.salt ? { salt: meta.opening.salt } : {}),
			fileCount: meta.fileCount,
			createdAt: meta.createdAt.toISOString(),
			expiresAt: meta.expiresAt.toISOString(),
		});
	});

	app.openapi(rawNoteRoute, async (c) => {
		const { meta, ciphertext } = await notes.read(
			c.req.valid("param").id,
			askedFormat(c.req.valid("query")),
		);
		return new Response(new Uint8Array(ciphertext) as BodyInit, {
			status: 200,
			headers: rawHeaders(meta, ciphertext.length),
		});
	});

	app.openapi(streamNoteRoute, async (c) => {
		const { meta, chunkCount, chunks } = await notes.stream(
			c.req.valid("param").id,
			askedFormat(c.req.valid("query")),
		);
		return new Response(lengthPrefixed(chunks) as BodyInit, {
			status: 200,
			headers: streamHeaders(meta, chunkCount),
		});
	});
}
