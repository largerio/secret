import type { OpenAPIHono } from "@hono/zod-openapi";
import { createNoteMultipartSchema } from "@largerio/secret-shared";
import { HTTPException } from "hono/http-exception";
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

/** What writes a note: creation in one request or by chunks, and deletion. */
export function registerWriteRoutes(app: OpenAPIHono, notes: NotesService): void {
	app.openapi(createNoteRoute, async (c) => {
		const { encryptedData, ...settings } = c.req.valid("json");
		const created = await notes.create(Buffer.from(encryptedData, "base64"), settings);
		return c.json(createdBody(created), 201);
	});

	app.openapi(uploadNoteRoute, async (c) => {
		const { metadata, data } = c.req.valid("form");
		// The settings travel as a JSON string inside the multipart body.
		const settings = parseJson(createNoteMultipartSchema, metadata);
		if (settings === undefined) {
			throw new HTTPException(400, { message: "Invalid request" });
		}
		const created = await notes.create(Buffer.from(await data.arrayBuffer()), settings);
		return c.json(createdBody(created), 201);
	});

	app.openapi(uploadInitRoute, (c) => {
		const session = notes.openUpload(c.req.valid("json"));
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

	app.openapi(deleteNoteRoute, async (c) => {
		await notes.delete(c.req.valid("param").id, c.req.valid("header")["x-delete-token"]);
		return c.json({ deleted: true as const });
	});
}
