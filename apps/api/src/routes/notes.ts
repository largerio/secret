import { createHash, timingSafeEqual } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { SECRETSTREAM_ABYTES, serverDecrypt, serverEncrypt } from "@secret/crypto";
import {
	chunkedUploadInitSchema,
	createNoteMultipartSchema,
	createNoteResponseSchema,
	createNoteSchema,
	deleteNoteResponseSchema,
	NOTE_ID_LENGTH,
	noteExistsResponseSchema,
	noteNotFoundResponseSchema,
	readNoteResponseSchema,
	UPLOAD_ID_LENGTH,
	UPLOAD_SESSION_TTL,
} from "@secret/shared";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { nanoid } from "nanoid";
import type { AppDatabase } from "../db/index.js";
import { notes, uploadChunks, uploads } from "../db/schema.js";
import { deleteOrSchedule } from "../pendingDeletions.js";
import type { StorageBackend } from "../storage/index.js";
import { StorageNotFoundError } from "../storage/index.js";

const DELETE_TOKEN_LENGTH = 32;

/** Strip CRLF and null bytes to prevent HTTP header injection */
function sanitizeHeaderValue(value: string): string {
	return value.replace(/[\r\n\0]/g, "");
}

function httpError(status: 400 | 401 | 403 | 404 | 500, message: string): never {
	throw new HTTPException(status, { message });
}

interface NotesEnv {
	Variables: {
		db: AppDatabase;
		serverKey: Buffer;
		storage: StorageBackend;
		chunkSize: number;
		maxChunkedFileSize: number;
		uploadId: string;
	};
}

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]+$/;

const validateUploadId: MiddlewareHandler<NotesEnv> = async (c, next) => {
	const id = c.req.param("uploadId");
	if (!id || !UPLOAD_ID_RE.test(id)) {
		return c.json({ error: "Invalid upload ID" }, 400);
	}
	c.set("uploadId", id);
	await next();
};

const noteIdParam = z
	.string()
	.regex(/^[A-Za-z0-9_-]+$/, "Invalid note ID format")
	.length(NOTE_ID_LENGTH, `Note ID must be ${String(NOTE_ID_LENGTH)} characters`)
	.openapi({ param: { name: "id", in: "path" }, example: "aBcDeFgHiJkL" });

// --- Route definitions ---

const createNoteRoute = createRoute({
	method: "post",
	path: "/",
	tags: ["Notes"],
	summary: "Create an encrypted note (JSON)",
	request: {
		body: { content: { "application/json": { schema: createNoteSchema } } },
	},
	responses: {
		201: {
			content: { "application/json": { schema: createNoteResponseSchema } },
			description: "Note created",
		},
	},
});

const existsRoute = createRoute({
	method: "get",
	path: "/{id}/exists",
	tags: ["Notes"],
	summary: "Check if a note exists",
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
		200: {
			content: {
				"application/json": {
					schema: z.union([noteExistsResponseSchema, noteNotFoundResponseSchema]),
				},
			},
			description: "Note existence check result",
		},
	},
});

const readNoteRoute = createRoute({
	method: "get",
	path: "/{id}",
	tags: ["Notes"],
	summary: "Read and decrypt a note (server-side decryption layer only)",
	request: {
		params: z.object({ id: noteIdParam }),
	},
	responses: {
		200: {
			content: { "application/json": { schema: readNoteResponseSchema } },
			description: "Note data (still client-encrypted)",
		},
	},
});

const deleteNoteRoute = createRoute({
	method: "delete",
	path: "/{id}",
	tags: ["Notes"],
	summary: "Delete a note",
	request: {
		params: z.object({ id: noteIdParam }),
		headers: z.object({ "x-delete-token": z.string().openapi({ example: "abc123..." }) }),
	},
	responses: {
		200: {
			content: { "application/json": { schema: deleteNoteResponseSchema } },
			description: "Note deleted",
		},
	},
});

// --- Handlers ---

export function createNotesRoutes() {
	const app = new OpenAPIHono<NotesEnv>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid request" }, 400);
			}
		},
	});

	async function insertNote(
		db: AppDatabase,
		serverKey: Buffer,
		storage: StorageBackend,
		params: {
			clientBlob: Buffer;
			clientNonce: string;
			hasPassword: boolean;
			expiresIn: number;
			maxReads: number;
			fileCount: number;
			salt: string | null;
		},
	) {
		const { encrypted: serverBlob, iv: serverIv } = serverEncrypt(params.clientBlob, serverKey);

		const id = nanoid(NOTE_ID_LENGTH);
		const deleteToken = nanoid(DELETE_TOKEN_LENGTH);
		const now = new Date();
		const expiresAt = new Date(now.getTime() + params.expiresIn * 1000);

		let filePath: string | null = null;
		let storedBlob: Buffer;
		if (params.fileCount > 0) {
			filePath = await storage.save(id, serverBlob);
			storedBlob = Buffer.alloc(0);
		} else {
			storedBlob = serverBlob;
		}

		db.insert(notes)
			.values({
				id,
				encryptedData: storedBlob,
				serverNonce: serverIv.toString("base64"),
				clientNonce: params.clientNonce,
				hasPassword: params.hasPassword,
				salt: params.salt,
				deleteToken,
				burnAfterRead: params.maxReads === 1,
				fileCount: params.fileCount,
				filePath,
				expiresAt,
				maxReads: params.maxReads,
				createdAt: now,
			})
			.run();

		return { id, expiresAt: expiresAt.toISOString(), deleteToken };
	}

	app.openapi(createNoteRoute, async (c) => {
		const { encryptedData, clientNonce, hasPassword, expiresIn, maxReads, fileCount, salt } =
			c.req.valid("json");

		const result = await insertNote(c.get("db"), c.get("serverKey"), c.get("storage"), {
			clientBlob: Buffer.from(encryptedData, "base64"),
			clientNonce,
			hasPassword,
			expiresIn,
			maxReads,
			fileCount,
			salt: salt ?? null,
		});

		return c.json(result, 201);
	});

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

		const result = await insertNote(c.get("db"), c.get("serverKey"), c.get("storage"), {
			clientBlob: Buffer.from(await dataBlob.arrayBuffer()),
			clientNonce,
			hasPassword,
			expiresIn,
			maxReads,
			fileCount,
			salt: salt ?? null,
		});

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
				chunkCount: notes.chunkCount,
			})
			.from(notes)
			.where(eq(notes.id, id))
			.get();

		if (note === undefined || note.expiresAt < new Date()) {
			return c.json({ exists: false as const });
		}

		return c.json({
			exists: true as const,
			hasPassword: note.hasPassword,
			fileCount: note.fileCount,
			expiresAt: note.expiresAt.toISOString(),
			maxReads: note.maxReads ?? 0,
			chunked: (note.chunkCount ?? 0) > 0,
		});
	});

	// Runs the shared consume-a-note transaction: enforces existence, expiry,
	// and max-reads atomically, schedules storage cleanup for expired rows,
	// and throws HTTPException for caller-observable errors. Returns the
	// live note plus a flag indicating whether the row was deleted because
	// readCount reached maxReads (callers finalize storage cleanup after
	// reading their payload).
	//
	// When `requireChunked` is true, returns 400 before incrementing the
	// read counter if the note has no chunk data — used by the streaming
	// endpoint so a shape-mismatched request does not burn a read.
	async function consumeNoteTx(
		db: AppDatabase,
		storage: StorageBackend,
		id: string,
		options?: { requireChunked?: boolean },
	) {
		const result = db.transaction((tx) => {
			const note = tx.select().from(notes).where(eq(notes.id, id)).get();

			if (note === undefined) {
				return { error: "Note not found" as const, status: 404 as const };
			}

			if (note.expiresAt < new Date()) {
				tx.delete(notes).where(eq(notes.id, id)).run();
				return {
					error: "Note has expired" as const,
					status: 404 as const,
					filePath: note.filePath,
					chunkCount: note.chunkCount,
				};
			}

			if (options?.requireChunked && (!note.chunkCount || !note.streamHeader)) {
				return { error: "Note is not a chunked note" as const, status: 400 as const };
			}

			const maxReads = note.maxReads ?? 0;
			const newReadCount = note.readCount + 1;
			const shouldDelete = maxReads > 0 && newReadCount >= maxReads;

			if (shouldDelete) {
				tx.delete(notes).where(eq(notes.id, id)).run();
			} else {
				tx.update(notes).set({ readCount: newReadCount }).where(eq(notes.id, id)).run();
			}

			return { note, shouldDelete };
		});

		if ("error" in result) {
			const filePath = "filePath" in result ? result.filePath : null;
			const chunkCount = "chunkCount" in result ? result.chunkCount : null;
			await deleteOrSchedule(db, storage, { noteId: id, filePath, chunkCount });
			httpError(result.status as 400 | 404, result.error);
		}

		return result;
	}

	async function consumeNote(
		db: AppDatabase,
		serverKey: Buffer,
		storage: StorageBackend,
		id: string,
	) {
		const result = await consumeNoteTx(db, storage, id);
		const { note } = result;
		const serverIv = Buffer.from(note.serverNonce, "base64");

		let clientBlob: Buffer;
		try {
			if (note.filePath) {
				const fileData = await storage.read(note.filePath);
				clientBlob = serverDecrypt(fileData, serverIv, serverKey);
			} else {
				clientBlob = serverDecrypt(note.encryptedData, serverIv, serverKey);
			}
		} catch (err) {
			if (result.shouldDelete) {
				await deleteOrSchedule(db, storage, { noteId: id, ...note });
			}
			if (err instanceof StorageNotFoundError) {
				httpError(404, "Note not found");
			} else {
				httpError(500, "Failed to decrypt note");
			}
		}

		if (result.shouldDelete) {
			await deleteOrSchedule(db, storage, { noteId: id, ...note });
		}

		return { clientBlob, note };
	}

	app.openapi(readNoteRoute, async (c) => {
		const { id } = c.req.valid("param");
		const { clientBlob, note } = await consumeNote(
			c.get("db"),
			c.get("serverKey"),
			c.get("storage"),
			id,
		);

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

	app.get("/:id/raw", async (c) => {
		const id = c.req.param("id");
		if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || id.length !== NOTE_ID_LENGTH) {
			return c.json({ error: "Invalid note ID" }, 400);
		}

		const { clientBlob, note } = await consumeNote(
			c.get("db"),
			c.get("serverKey"),
			c.get("storage"),
			id,
		);

		const headers: Record<string, string> = {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(clientBlob.length),
			"X-Client-Nonce": sanitizeHeaderValue(note.clientNonce),
			"X-Has-Password": String(note.hasPassword),
			"X-File-Count": String(note.fileCount),
			"X-Created-At": note.createdAt.toISOString(),
			"X-Expires-At": note.expiresAt.toISOString(),
		};
		if (note.salt) {
			headers["X-Salt"] = sanitizeHeaderValue(note.salt);
		}

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

			return { note };
		});

		if ("error" in result) {
			httpError(result.status as 403, result.error);
		}

		await deleteOrSchedule(db, storage, { noteId: id, ...result.note });

		return c.json({ deleted: true as const });
	});

	// --- Chunked upload endpoints ---

	app.post("/upload/init", async (c) => {
		const body = await c.req.json().catch(() => null);
		if (!body) return c.json({ error: "Invalid JSON body" }, 400);

		const parsed = chunkedUploadInitSchema.safeParse(body);
		if (!parsed.success) return c.json({ error: "Invalid request" }, 400);

		const data = parsed.data;
		const chunkSize = c.get("chunkSize");
		const maxChunkedSize = c.get("maxChunkedFileSize");
		const maxChunks = Math.ceil(maxChunkedSize / chunkSize);

		if (data.chunkCount > maxChunks) {
			return c.json({ error: `Maximum ${String(maxChunks)} chunks allowed` }, 400);
		}

		const db = c.get("db");
		const uploadId = nanoid(UPLOAD_ID_LENGTH);
		const noteId = nanoid(NOTE_ID_LENGTH);
		const deleteToken = nanoid(DELETE_TOKEN_LENGTH);
		const now = new Date();
		const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL * 1000);

		const metadata = JSON.stringify({
			streamHeader: data.streamHeader,
			clientNonce: data.clientNonce,
			hasPassword: data.hasPassword,
			expiresIn: data.expiresIn,
			maxReads: data.maxReads,
			fileCount: data.fileCount,
			...(data.salt ? { salt: data.salt } : {}),
		});

		db.insert(uploads)
			.values({
				id: uploadId,
				metadata,
				chunkCount: data.chunkCount,
				noteId,
				deleteToken,
				createdAt: now,
				expiresAt,
			})
			.run();

		return c.json({ uploadId, expiresAt: expiresAt.toISOString() }, 201);
	});

	app.use("/upload/:uploadId/chunks/*", validateUploadId);
	app.use("/upload/:uploadId/complete", validateUploadId);

	app.put("/upload/:uploadId/chunks/:index", async (c) => {
		const uploadId = c.get("uploadId");
		const indexStr = c.req.param("index");
		const index = parseInt(indexStr as string, 10);

		if (Number.isNaN(index) || index < 0) {
			return c.json({ error: "Invalid chunk index" }, 400);
		}

		const db = c.get("db");
		const session = db.select().from(uploads).where(eq(uploads.id, uploadId)).get();

		if (session === undefined || session.expiresAt < new Date()) {
			return c.json({ error: "Upload session not found or expired" }, 404);
		}

		if (index >= session.chunkCount) {
			return c.json({ error: "Chunk index out of range" }, 400);
		}

		const rawBody = await c.req.arrayBuffer();
		if (rawBody.byteLength === 0) {
			return c.json({ error: "Empty chunk body" }, 400);
		}

		const chunkSize = c.get("chunkSize");
		const maxChunkBytes = chunkSize + SECRETSTREAM_ABYTES;
		if (rawBody.byteLength > maxChunkBytes) {
			return c.json({ error: "Chunk too large" }, 413);
		}

		// Verify SHA-256 hash
		const expectedHash = c.req.header("X-Chunk-Hash");
		if (!expectedHash) {
			return c.json({ error: "Missing X-Chunk-Hash header" }, 400);
		}
		const actualHash = createHash("sha256").update(Buffer.from(rawBody)).digest("hex");
		if (actualHash !== expectedHash) {
			return c.json({ error: "Chunk hash mismatch" }, 400);
		}

		// Server-encrypt the chunk (prepend IV to stored data)
		const serverKey = c.get("serverKey");
		const { encrypted, iv } = serverEncrypt(Buffer.from(rawBody), serverKey);
		const storedData = Buffer.concat([iv, encrypted]);

		const storage = c.get("storage");
		await storage.saveChunk(session.noteId, index, storedData);

		db.insert(uploadChunks)
			.values({ uploadId: uploadId, chunkIndex: index })
			.onConflictDoNothing()
			.run();

		return c.json({ received: true as const });
	});

	app.post("/upload/:uploadId/complete", async (c) => {
		const uploadId = c.get("uploadId");

		const db = c.get("db");
		const session = db.select().from(uploads).where(eq(uploads.id, uploadId)).get();

		if (session === undefined || session.expiresAt < new Date()) {
			return c.json({ error: "Upload session not found or expired" }, 404);
		}

		const rows = db
			.select({ chunkIndex: uploadChunks.chunkIndex })
			.from(uploadChunks)
			.where(eq(uploadChunks.uploadId, uploadId))
			.all();

		if (rows.length < session.chunkCount) {
			return c.json({ error: "Upload incomplete" }, 400);
		}

		let meta: {
			streamHeader: string;
			clientNonce: string;
			hasPassword: boolean;
			expiresIn: number;
			maxReads: number;
			fileCount: number;
			salt?: string;
		};
		try {
			meta = JSON.parse(session.metadata) as typeof meta;
		} catch {
			return c.json({ error: "Corrupted upload session" }, 500);
		}

		const now = new Date();
		const expiresAt = new Date(now.getTime() + meta.expiresIn * 1000);

		// Transaction: check duplicate + insert note + delete session atomically
		const result = db.transaction((tx) => {
			const existing = tx
				.select({ id: notes.id })
				.from(notes)
				.where(eq(notes.id, session.noteId))
				.get();
			if (existing !== undefined) {
				return { error: "Upload already completed" as const };
			}

			tx.insert(notes)
				.values({
					id: session.noteId,
					encryptedData: Buffer.alloc(0),
					serverNonce: "",
					clientNonce: meta.clientNonce,
					hasPassword: meta.hasPassword,
					salt: meta.salt ?? null,
					deleteToken: session.deleteToken,
					burnAfterRead: meta.maxReads === 1,
					fileCount: meta.fileCount,
					filePath: null,
					expiresAt,
					maxReads: meta.maxReads,
					createdAt: now,
					chunkCount: session.chunkCount,
					streamHeader: meta.streamHeader,
				})
				.run();

			tx.delete(uploads).where(eq(uploads.id, uploadId)).run();

			return { success: true as const };
		});

		if ("error" in result) {
			return c.json({ error: result.error }, 409);
		}

		return c.json(
			{
				id: session.noteId,
				expiresAt: expiresAt.toISOString(),
				deleteToken: session.deleteToken,
			},
			201,
		);
	});

	// --- Chunked stream download ---

	app.get("/:id/stream", async (c) => {
		const id = c.req.param("id");
		if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || id.length !== NOTE_ID_LENGTH) {
			return c.json({ error: "Invalid note ID" }, 400);
		}

		const db = c.get("db");
		const serverKey = c.get("serverKey");
		const storage = c.get("storage");

		const result = await consumeNoteTx(db, storage, id, { requireChunked: true });
		const { note } = result;
		const chunkCount = note.chunkCount as number;

		const headers: Record<string, string> = {
			"Content-Type": "application/octet-stream",
			"X-Stream-Header": sanitizeHeaderValue(note.streamHeader as string),
			"X-Chunk-Count": String(chunkCount),
			"X-Has-Password": String(note.hasPassword),
			"X-File-Count": String(note.fileCount),
			"X-Created-At": note.createdAt.toISOString(),
			"X-Expires-At": note.expiresAt.toISOString(),
		};
		if (note.salt) {
			headers["X-Salt"] = sanitizeHeaderValue(note.salt);
		}

		const IV_LENGTH = 12;
		const AUTH_TAG_LENGTH = 16;

		// Pre-flight the first chunk so a missing payload maps to a 404 before
		// we commit to streaming a 200. Once headers are sent, any subsequent
		// error can only break the stream mid-flight.
		let firstChunk: Buffer;
		try {
			firstChunk = await storage.readChunk(id, 0);
		} catch (err) {
			if (result.shouldDelete) {
				await deleteOrSchedule(db, storage, { noteId: id, chunkCount });
			}
			if (err instanceof StorageNotFoundError) {
				return c.json({ error: "Note not found" }, 404);
			}
			throw err;
		}

		const stream = new ReadableStream({
			async start(controller) {
				try {
					for (let i = 0; i < chunkCount; i++) {
						const storedData = i === 0 ? firstChunk : await storage.readChunk(id, i);
						const iv = storedData.subarray(0, IV_LENGTH);
						const encrypted = storedData.subarray(IV_LENGTH);

						// Verify minimum size for auth tag
						if (encrypted.length < AUTH_TAG_LENGTH) {
							controller.error(new Error("Invalid chunk data"));
							return;
						}

						const clientChunk = serverDecrypt(encrypted, iv, serverKey);

						// Length-prefix framing: 4 bytes big-endian length + chunk data
						const lengthBuf = Buffer.alloc(4);
						lengthBuf.writeUInt32BE(clientChunk.length);
						controller.enqueue(new Uint8Array(lengthBuf));
						controller.enqueue(new Uint8Array(clientChunk));
					}

					controller.close();
				} catch (err) {
					controller.error(err);
				} finally {
					if (result.shouldDelete) {
						await deleteOrSchedule(db, storage, { noteId: id, chunkCount });
					}
				}
			},
		});

		return new Response(stream as BodyInit, { status: 200, headers });
	});

	return app;
}
