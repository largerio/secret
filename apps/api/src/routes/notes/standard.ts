import { timingSafeEqual } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
	createNoteMultipartSchema,
	isValidNoteId,
	MAX_INLINE_ENCRYPTED_SIZE,
} from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import { notes } from "../../db/schema.js";
import { enqueueDeletion, hasStoredPayload, runDeletion } from "../../pendingDeletions.js";
import {
	assertWithinPolicy,
	buildNoteHeaders,
	consumeNote,
	httpError,
	insertNote,
	type NotesEnv,
	sanitizeHeaderValue,
} from "./helpers.js";
import {
	createNoteRoute,
	deleteNoteRoute,
	existsRoute,
	rawNoteRoute,
	readNoteRoute,
	uploadNoteRoute,
} from "./openapi-routes.js";

export function registerStandardRoutes(app: OpenAPIHono<NotesEnv>): void {
	app.openapi(createNoteRoute, async (c) => {
		const { encryptedData, clientNonce, hasPassword, expiresIn, maxReads, fileCount, salt } =
			c.req.valid("json");

		assertWithinPolicy(
			{ maxExpirySeconds: c.get("maxExpirySeconds"), maxFilesPerNote: c.get("maxFilesPerNote") },
			{ expiresIn, fileCount },
		);

		const clientBlob = Buffer.from(encryptedData, "base64");
		// Without files the note is stored inline in SQLite, whose reads block the
		// event loop: keep it text-sized. Larger payloads belong in a file upload.
		if (fileCount === 0 && clientBlob.byteLength > MAX_INLINE_ENCRYPTED_SIZE) {
			httpError(413, "Payload too large");
		}

		const result = await insertNote(c.get("db"), c.get("serverKey"), c.get("storage"), {
			clientBlob,
			clientNonce,
			hasPassword,
			expiresIn,
			maxReads,
			fileCount,
			salt: salt ?? null,
			quotaBytes: c.get("storageQuotaBytes"),
		});
		c.get("metrics").noteCreated(fileCount > 0 ? "file" : "text");

		return c.json(result, 201);
	});

	// Multipart bodies are validated manually below, so the route is documented
	// via the registry instead of app.openapi().
	app.openAPIRegistry.registerPath(uploadNoteRoute);
	app.post("/upload", async (c) => {
		let formData: FormData;
		try {
			formData = await c.req.formData();
		} catch {
			return c.json({ error: "Invalid multipart body" }, 400);
		}

		const metadataRaw = formData.get("metadata");
		const dataBlob = formData.get("data");

		if (typeof metadataRaw !== "string") {
			return c.json({ error: "Missing metadata part" }, 400);
		}
		if (!(dataBlob instanceof File)) {
			return c.json({ error: "Missing data part" }, 400);
		}

		let metadata: unknown;
		try {
			metadata = JSON.parse(metadataRaw);
		} catch {
			return c.json({ error: "Invalid metadata JSON" }, 400);
		}

		const parsed = createNoteMultipartSchema.safeParse(metadata);
		if (!parsed.success) {
			return c.json({ error: "Invalid request" }, 400);
		}

		const { clientNonce, hasPassword, expiresIn, maxReads, fileCount, salt } = parsed.data;

		assertWithinPolicy(
			{ maxExpirySeconds: c.get("maxExpirySeconds"), maxFilesPerNote: c.get("maxFilesPerNote") },
			{ expiresIn, fileCount },
		);

		const result = await insertNote(c.get("db"), c.get("serverKey"), c.get("storage"), {
			clientBlob: Buffer.from(await dataBlob.arrayBuffer()),
			clientNonce,
			hasPassword,
			expiresIn,
			maxReads,
			fileCount,
			salt: salt ?? null,
			quotaBytes: c.get("storageQuotaBytes"),
		});
		// The multipart schema asks for at least one file.
		c.get("metrics").noteCreated("file");

		return c.json(result, 201);
	});

	app.openapi(existsRoute, (c) => {
		const { id } = c.req.valid("param");

		const db = c.get("db");
		const note = db
			.select({
				hasPassword: notes.hasPassword,
				fileCount: notes.fileCount,
				expiresAt: notes.expiresAt,
				maxReads: notes.maxReads,
				readCount: notes.readCount,
				chunkCount: notes.chunkCount,
			})
			.from(notes)
			.where(eq(notes.id, id))
			.get();

		if (note === undefined || note.expiresAt < new Date()) {
			return c.json({ exists: false as const });
		}

		const maxReads = note.maxReads ?? 0;

		return c.json({
			exists: true as const,
			hasPassword: note.hasPassword,
			fileCount: note.fileCount,
			expiresAt: note.expiresAt.toISOString(),
			maxReads,
			// The count only matters against a limit. An unlimited note keeps
			// counting forever, and reporting that would hand anyone holding the
			// link a live view counter, so it stays at 0.
			readCount: maxReads > 0 ? note.readCount : 0,
			chunked: (note.chunkCount ?? 0) > 0,
		});
	});

	app.openapi(readNoteRoute, async (c) => {
		const { id } = c.req.valid("param");
		const { clientBlob, note, burned } = await consumeNote(
			c.get("db"),
			c.get("serverKey"),
			c.get("storage"),
			id,
			c.get("metrics"),
		);
		c.get("metrics").noteRead(note.filePath ? "file" : "text", burned);

		return c.json({
			encryptedData: clientBlob.toString("base64"),
			clientNonce: note.clientNonce,
			hasPassword: note.hasPassword,
			...(note.salt ? { salt: note.salt } : {}),
			fileCount: note.fileCount,
			createdAt: note.createdAt.toISOString(),
			expiresAt: note.expiresAt.toISOString(),
		});
	});

	// Binary response endpoint — documented via the registry, validated manually.
	app.openAPIRegistry.registerPath(rawNoteRoute);
	app.get("/:id/raw", async (c) => {
		const id = c.req.param("id");
		if (!id || !isValidNoteId(id)) {
			return c.json({ error: "Invalid note ID" }, 400);
		}

		const { clientBlob, note, burned } = await consumeNote(
			c.get("db"),
			c.get("serverKey"),
			c.get("storage"),
			id,
			c.get("metrics"),
		);
		c.get("metrics").noteRead(note.filePath ? "file" : "text", burned);

		const headers = buildNoteHeaders(note);
		headers["Content-Length"] = String(clientBlob.length);
		headers["X-Client-Nonce"] = sanitizeHeaderValue(note.clientNonce);

		return new Response(new Uint8Array(clientBlob) as BodyInit, { status: 200, headers });
	});

	app.openapi(deleteNoteRoute, async (c) => {
		const { id } = c.req.valid("param");
		const token = c.req.valid("header")["x-delete-token"];

		const db = c.get("db");
		const storage = c.get("storage");

		const result = db.transaction((tx) => {
			const note = tx
				.select({
					filePath: notes.filePath,
					deleteToken: notes.deleteToken,
					chunkCount: notes.chunkCount,
				})
				.from(notes)
				.where(eq(notes.id, id))
				.get();

			if (note === undefined) {
				return { error: "Note not found" as const, status: 404 as const };
			}

			const tokenBuf = Buffer.from(token);
			const storedBuf = Buffer.from(note.deleteToken);
			if (tokenBuf.length !== storedBuf.length || !timingSafeEqual(tokenBuf, storedBuf)) {
				return { error: "Invalid delete token" as const, status: 403 as const };
			}

			tx.delete(notes).where(eq(notes.id, id)).run();

			return hasStoredPayload(note) ? { deletion: enqueueDeletion(tx, id) } : {};
		});

		if ("error" in result) {
			httpError(result.status as 403, result.error);
		}

		if (result.deletion) {
			await runDeletion(db, storage, result.deletion);
		}
		c.get("metrics").noteDeleted();

		return c.json({ deleted: true as const });
	});
}
