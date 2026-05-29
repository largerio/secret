import { createHash } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { SECRETSTREAM_ABYTES, serverDecrypt, serverEncrypt } from "@secret/crypto";
import {
	chunkedUploadInitSchema,
	NOTE_ID_LENGTH,
	UPLOAD_ID_LENGTH,
	UPLOAD_SESSION_TTL,
} from "@secret/shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { notes, uploadChunks, uploads } from "../../db/schema.js";
import { deleteOrSchedule } from "../../pendingDeletions.js";
import { StorageNotFoundError } from "../../storage/index.js";
import {
	consumeNoteTx,
	DELETE_TOKEN_LENGTH,
	type NotesEnv,
	sanitizeHeaderValue,
	validateUploadId,
} from "./helpers.js";

export function registerChunkedRoutes(app: OpenAPIHono<NotesEnv>): void {
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
}
