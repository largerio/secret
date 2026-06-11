import { serverDecrypt, serverEncrypt } from "@largerio/secret-crypto/server";
import { NOTE_ID_LENGTH } from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { nanoid } from "nanoid";
import type { AppDatabase } from "../../db/index.js";
import { notes } from "../../db/schema.js";
import { deleteOrSchedule } from "../../pendingDeletions.js";
import type { StorageBackend } from "../../storage/index.js";
import { StorageNotFoundError } from "../../storage/index.js";

export const DELETE_TOKEN_LENGTH = 32;

export interface NotesEnv {
	Variables: {
		db: AppDatabase;
		serverKey: Buffer;
		storage: StorageBackend;
		chunkSize: number;
		maxChunkedFileSize: number;
		uploadId: string;
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
export function buildNoteHeaders(note: {
	hasPassword: boolean;
	fileCount: number;
	createdAt: Date;
	expiresAt: Date;
	salt: string | null;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/octet-stream",
		// Force a download and forbid MIME sniffing so the still-encrypted blob
		// is never interpreted/executed in a browser context (defense in depth;
		// the global security middleware also sets nosniff).
		"Content-Disposition": "attachment",
		"X-Content-Type-Options": "nosniff",
		"X-Has-Password": String(note.hasPassword),
		"X-File-Count": String(note.fileCount),
		"X-Created-At": note.createdAt.toISOString(),
		"X-Expires-At": note.expiresAt.toISOString(),
	};
	if (note.salt) {
		headers["X-Salt"] = sanitizeHeaderValue(note.salt);
	}
	return headers;
}

export function httpError(status: 400 | 401 | 403 | 404 | 500, message: string): never {
	throw new HTTPException(status, { message });
}

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]+$/;

export const validateUploadId: MiddlewareHandler<NotesEnv> = async (c, next) => {
	const id = c.req.param("uploadId");
	if (!id || !UPLOAD_ID_RE.test(id)) {
		return c.json({ error: "Invalid upload ID" }, 400);
	}
	c.set("uploadId", id);
	await next();
};

export async function insertNote(
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
	// Generate the id first so it can be bound to the server-layer ciphertext as
	// AAD (see serverEncrypt): each blob is pinned to its note row.
	const id = nanoid(NOTE_ID_LENGTH);
	const { encrypted: serverBlob, iv: serverIv } = serverEncrypt(
		params.clientBlob,
		serverKey,
		Buffer.from(id),
	);

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
export async function consumeNoteTx(
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
			// Return the same message/status as a non-existent note so the read
			// endpoint cannot be used as an oracle to distinguish "expired" from
			// "never existed" (the /exists endpoint already conflates both).
			return {
				error: "Note not found" as const,
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

export async function consumeNote(
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
		const aad = Buffer.from(id);
		if (note.filePath) {
			const fileData = await storage.read(note.filePath);
			clientBlob = serverDecrypt(fileData, serverIv, serverKey, aad);
		} else {
			clientBlob = serverDecrypt(note.encryptedData, serverIv, serverKey, aad);
		}
	} catch (err) {
		if (err instanceof StorageNotFoundError) {
			httpError(404, "Note not found");
		}
		httpError(500, "Failed to decrypt note");
	} finally {
		// Finalize storage cleanup for a burned note on both the success and
		// error paths (the catch above always throws via httpError).
		if (result.shouldDelete) {
			await deleteOrSchedule(db, storage, { noteId: id, ...note });
		}
	}

	return { clientBlob, note };
}
