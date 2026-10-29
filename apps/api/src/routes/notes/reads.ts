import type { OpenAPIHono } from "@hono/zod-openapi";
import type { NotesService } from "../../notes/service.js";
import {
	existsRoute,
	rawNoteRoute,
	readNoteRoute,
	readWithProofsRoute,
	streamNoteRoute,
} from "./openapi-routes.js";
import { rawResponse, streamResponse } from "./responses.js";

/**
 * What reads a note: its state, its ciphertext in one piece or as a stream in
 * format 0, and either kind in format 1, once its proofs check out.
 */
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
			...(info.envelope ? { envelope: info.envelope.toString("base64") } : {}),
			...(info.passwordAttemptsLeft !== undefined
				? { passwordAttemptsLeft: info.passwordAttemptsLeft }
				: {}),
		});
	});

	app.openapi(readNoteRoute, async (c) => {
		// Its answer has format 0's fields: format 1 notes are not served here.
		const { meta, ciphertext } = await notes.read(c.req.valid("param").id);
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
		return rawResponse(await notes.read(c.req.valid("param").id));
	});

	app.openapi(streamNoteRoute, async (c) => {
		return streamResponse(await notes.stream(c.req.valid("param").id));
	});

	// A POST: it changes the note (a read spent, or a wrong password counted),
	// and its proofs travel in the body, out of the URLs that logs and caches
	// keep. It answers as /raw or /stream do, by the note's kind.
	app.openapi(readWithProofsRoute, async (c) => {
		const read = await notes.readWithProofs(c.req.valid("param").id, c.req.valid("json"));
		return read.kind === "chunked" ? streamResponse(read) : rawResponse(read);
	});
}
