import { createHash } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { SECRETSTREAM_ABYTES } from "@largerio/secret-crypto/client";
import { serverDecrypt, serverEncrypt } from "@largerio/secret-crypto/server";
import {
	chunkedUploadInitSchema,
	isValidNoteId,
	NOTE_ID_LENGTH,
	UPLOAD_ID_LENGTH,
	UPLOAD_SESSION_TTL,
	uploadSessionMetadataSchema,
} from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { notes, uploadChunks, uploads } from "../../db/schema.js";
import { deleteOrSchedule } from "../../pendingDeletions.js";
import { StorageNotFoundError } from "../../storage/index.js";
import {
	assertWithinPolicy,
	buildNoteHeaders,
	consumeNoteTx,
	DELETE_TOKEN_LENGTH,
	type NotesEnv,
	sanitizeHeaderValue,
	validateUploadId,
} from "./helpers.js";
import {
	streamNoteRoute,
	uploadChunkRoute,
	uploadCompleteRoute,
	uploadInitRoute,
} from "./openapi-routes.js";

export function registerChunkedRoutes(app: OpenAPIHono<NotesEnv>): void {
	// These handlers validate manually (binary bodies, custom error shapes), so
	// they are documented via the registry instead of app.openapi().
	app.openAPIRegistry.registerPath(uploadInitRoute);
	app.openAPIRegistry.registerPath(uploadChunkRoute);
	app.openAPIRegistry.registerPath(uploadCompleteRoute);
	app.openAPIRegistry.registerPath(streamNoteRoute);

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

		assertWithinPolicy(
			{ maxExpirySeconds: c.get("maxExpirySeconds"), maxFilesPerNote: c.get("maxFilesPerNote") },
			{ expiresIn: data.expiresIn, fileCount: data.fileCount },
		);

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
		const indexStr = c.req.param("index") as string;

		// Digits only — parseInt would silently truncate inputs like "1.5" or "12abc".
		if (!/^\d+$/.test(indexStr)) {
			return c.json({ error: "Invalid chunk index" }, 400);
		}
		const index = Number(indexStr);

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

		// Server-encrypt the chunk (prepend IV to stored data). Bind each chunk to
		// its note id via AAD so a chunk cannot be relocated to another note.
		const serverKey = c.get("serverKey");
		const { encrypted, iv } = serverEncrypt(
			Buffer.from(rawBody),
			serverKey,
			Buffer.from(session.noteId),
		);
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

		// Re-validate the persisted metadata instead of trusting it blindly:
		// a corrupted row (bad JSON or missing fields) must not produce a
		// malformed note.
		let parsedMetadata: unknown;
		try {
			parsedMetadata = JSON.parse(session.metadata);
		} catch {
			return c.json({ error: "Corrupted upload session" }, 500);
		}
		const metaResult = uploadSessionMetadataSchema.safeParse(parsedMetadata);
		if (!metaResult.success) {
			return c.json({ error: "Corrupted upload session" }, 500);
		}
		const meta = metaResult.data;

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
		if (!id || !isValidNoteId(id)) {
			return c.json({ error: "Invalid note ID" }, 400);
		}

		const db = c.get("db");
		const serverKey = c.get("serverKey");
		const storage = c.get("storage");

		const result = await consumeNoteTx(db, storage, id, { expect: "chunked" });
		const { note } = result;
		const chunkCount = note.chunkCount as number;

		const headers = buildNoteHeaders(note);
		headers["X-Stream-Header"] = sanitizeHeaderValue(note.streamHeader as string);
		headers["X-Chunk-Count"] = String(chunkCount);

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

		// Read-ahead window: keep a few chunk reads in flight so per-chunk
		// storage latency (one round-trip per chunk on S3) overlaps with
		// decryption and streaming instead of accumulating sequentially.
		// Rejections are captured as values so an un-awaited prefetch can
		// never surface as an unhandled promise rejection.
		const PREFETCH_CHUNKS = 4;
		type ChunkRead = { ok: true; data: Buffer } | { ok: false; reason: unknown };
		const readChunkSafe = (index: number): Promise<ChunkRead> =>
			(index === 0 ? Promise.resolve(firstChunk) : storage.readChunk(id, index)).then(
				(data) => ({ ok: true as const, data }),
				(reason: unknown) => ({ ok: false as const, reason }),
			);

		const stream = new ReadableStream({
			async start(controller) {
				try {
					const readAhead: Promise<ChunkRead>[] = [];
					let nextToFetch = 0;

					for (let i = 0; i < chunkCount; i++) {
						// Top up the read-ahead window.
						while (nextToFetch < chunkCount && readAhead.length < PREFETCH_CHUNKS) {
							readAhead.push(readChunkSafe(nextToFetch));
							nextToFetch += 1;
						}

						const chunkRead = await (readAhead.shift() as Promise<ChunkRead>);
						if (!chunkRead.ok) {
							controller.error(chunkRead.reason);
							return;
						}

						const storedData = chunkRead.data;
						const iv = storedData.subarray(0, IV_LENGTH);
						const encrypted = storedData.subarray(IV_LENGTH);

						// Verify minimum size for auth tag
						if (encrypted.length < AUTH_TAG_LENGTH) {
							controller.error(new Error("Invalid chunk data"));
							return;
						}

						const clientChunk = serverDecrypt(encrypted, iv, serverKey, Buffer.from(id));

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
