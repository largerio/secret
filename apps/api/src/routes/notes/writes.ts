import type { OpenAPIHono } from "@hono/zod-openapi";
import { createNoteMultipartRequestSchema } from "@largerio/secret-shared";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { chunkedSettingsOf, settingsOf } from "../../notes/formats.js";
import type { NotesService } from "../../notes/service.js";
import { parseJson } from "../../parseJson.js";
import {
	createNoteRoute,
	deleteNoteRoute,
	uploadChunkRoute,
	uploadCompleteRoute,
	uploadInitRoute,
	uploadNoteRoute,
} from "./openapi-routes.js";
import { createdBody } from "./responses.js";

/**
 * What writes a note: creation in one request or by chunks, and deletion.
 * `writeAuth` guards the routes that create a note or open its upload, and
 * deletion: it runs before the request is validated, so an unauthenticated one
 * is refused before its body is read. An upload's chunks and its completion
 * need none: the upload id stands for the authentication its opening gave.
 */
export function registerWriteRoutes(
	app: OpenAPIHono,
	notes: NotesService,
	writeAuth: MiddlewareHandler,
): void {
	app.openapi({ ...createNoteRoute, middleware: writeAuth }, async (c) => {
		const { encryptedData, ...request } = c.req.valid("json");
		const created = await notes.create(Buffer.from(encryptedData, "base64"), settingsOf(request));
		return c.json(createdBody(created), 201);
	});

	app.openapi({ ...uploadNoteRoute, middleware: writeAuth }, async (c) => {
		const { metadata, data } = c.req.valid("form");
		// The settings travel as a JSON string inside the multipart body.
		const request = parseJson(createNoteMultipartRequestSchema, metadata);
		if (request === undefined) {
			throw new HTTPException(400, { message: "Invalid request" });
		}
		const created = await notes.create(Buffer.from(await data.arrayBuffer()), settingsOf(request));
		return c.json(createdBody(created), 201);
	});

	app.openapi({ ...uploadInitRoute, middleware: writeAuth }, (c) => {
		const { chunkCount, ...request } = c.req.valid("json");
		const session = notes.openUpload({ ...chunkedSettingsOf(request), chunkCount });
		return c.json({ uploadId: session.uploadId, expiresAt: session.expiresAt.toISOString() }, 201);
	});

	app.openapi(uploadChunkRoute, async (c) => {
		const { uploadId, index } = c.req.valid("param");
		await notes.receiveChunk({
			uploadId,
			index: Number(index),
			hash: c.req.valid("header")["x-chunk-hash"],
			readBody: () => c.req.arrayBuffer(),
		});
		return c.json({ received: true as const }, 200);
	});

	app.openapi(uploadCompleteRoute, (c) => {
		const created = notes.completeUpload(c.req.valid("param").uploadId);
		return c.json(createdBody(created), 201);
	});

	app.openapi({ ...deleteNoteRoute, middleware: writeAuth }, async (c) => {
		await notes.delete(c.req.valid("param").id, c.req.valid("header")["x-delete-token"]);
		return c.json({ deleted: true as const }, 200);
	});
}
