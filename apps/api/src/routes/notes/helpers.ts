import { serverDecrypt, serverEncrypt } from "@largerio/secret-crypto/server";
import { NOTE_ID_LENGTH, UPLOAD_ID_LENGTH } from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { nanoid } from "nanoid";
import type { AppDatabase } from "../../db/index.js";
import { notes } from "../../db/schema.js";
import type { AppMetrics } from "../../metrics.js";
import {
	cancelDeletion,
	enqueueDeletion,
	hasStoredPayload,
	type PendingDeletion,
	runDeletion,
} from "../../pendingDeletions.js";
import { assertStorageQuota } from "../../quota.js";
import type { StorageBackend } from "../../storage/index.js";
import { StorageNotFoundError } from "../../storage/index.js";

export const DELETE_TOKEN_LENGTH = 32;

// How long a file save may run before the cleanup job treats its object as
// abandoned and purges it.
const SAVE_WINDOW_MS = 60 * 60_000;

export interface NotesEnv {
	Variables: {
		db: AppDatabase;
		serverKey: Buffer;
		storage: StorageBackend;
		chunkSize: number;
		maxChunkedFileSize: number;
		maxExpirySeconds: number;
		maxFilesPerNote: number;
		storageQuotaBytes: number;
		metrics: AppMetrics;
		uploadId: string;
	};
}

/**
 * Enforce the operator's policy on a create request.
 *
 * The Zod schemas encode the *protocol* ceilings, which are compiled in and
 * identical everywhere. The deployment-specific limits live in AppConfig, and
 * used to be advertised by `GET /api/v1/config` without ever being checked —
 * so an operator who set `MAX_EXPIRY=3600` for a retention policy, or
 * `MAX_FILES_PER_NOTE=3`, saw their value echoed back while the server kept
 * accepting 30-day, 10-file notes.
 */
export function assertWithinPolicy(
	limits: { maxExpirySeconds: number; maxFilesPerNote: number },
	request: { expiresIn: number; fileCount: number },
): void {
	if (request.expiresIn > limits.maxExpirySeconds) {
		httpError(400, `Maximum expiry is ${String(limits.maxExpirySeconds)} seconds`);
	}
	if (request.fileCount > limits.maxFilesPerNote) {
		httpError(400, `Maximum ${String(limits.maxFilesPerNote)} files per note`);
	}
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
		// A 200 without cache directives is heuristically cacheable (RFC 9111
		// §4.2.2), so a CDN or the browser cache could replay a burn-after-read
		// note after the row is gone. The global no-store middleware covers this
		// too; repeated here because these headers bypass c.json().
		"Cache-Control": "no-store",
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

export function httpError(
	status: 400 | 401 | 403 | 404 | 413 | 500,
	message: string,
	cause?: unknown,
): never {
	throw new HTTPException(status, { message, ...(cause !== undefined ? { cause } : {}) });
}

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]+$/;

export const validateUploadId: MiddlewareHandler<NotesEnv> = async (c, next) => {
	const id = c.req.param("uploadId");
	// Length is enforced alongside the charset so the lookup key stays bounded
	// and matches the `.length(UPLOAD_ID_LENGTH)` the OpenAPI schema advertises.
	if (!id || id.length !== UPLOAD_ID_LENGTH || !UPLOAD_ID_RE.test(id)) {
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
		quotaBytes: number;
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

	// Checked against the stored size (post-encryption) before anything is
	// written, so a full instance refuses cleanly with 507 instead of failing
	// half-way with a stranded blob.
	assertStorageQuota(db, params.quotaBytes, serverBlob.length);

	const deleteToken = nanoid(DELETE_TOKEN_LENGTH);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + params.expiresIn * 1000);

	let filePath: string | null = null;
	let storedBlob = serverBlob;
	// The blob is written before its row exists. Its purge is queued first, so
	// a crash or a failure anywhere in between leaves a pending deletion
	// instead of an object no row points to; the insert takes it back.
	let saving: PendingDeletion | undefined;
	if (params.fileCount > 0) {
		saving = db.transaction((tx) => enqueueDeletion(tx, id, SAVE_WINDOW_MS));
		try {
			filePath = await storage.save(id, serverBlob);
		} catch (err) {
			// A failed write can still leave a partial file behind.
			await runDeletion(db, storage, saving);
			throw err;
		}
		storedBlob = Buffer.alloc(0);
	}

	try {
		db.transaction((tx) => {
			tx.insert(notes)
				.values({
					id,
					encryptedData: storedBlob,
					serverNonce: serverIv.toString("base64"),
					clientNonce: params.clientNonce,
					hasPassword: params.hasPassword,
					salt: params.salt,
					deleteToken,
					fileCount: params.fileCount,
					filePath,
					expiresAt,
					maxReads: params.maxReads,
					createdAt: now,
					sizeBytes: serverBlob.length,
				})
				.run();
			if (saving) {
				cancelDeletion(tx, saving);
			}
		});
	} catch (err) {
		// Disk full, SQLITE_BUSY, corruption: the blob has no row to belong to.
		if (saving) {
			await runDeletion(db, storage, saving);
		}
		throw err;
	}

	return { id, expiresAt: expiresAt.toISOString(), deleteToken };
}

// Finds the note a read is about to be served from: enforces existence and
// expiry, purges the payload of an expired row, and throws HTTPException for
// caller-observable errors. It counts nothing — callers load and verify the
// payload first, then call consumeRead.
//
// `expect` declares which storage shape the calling endpoint can actually
// serve. A mismatch returns 400, so a request aimed at the wrong endpoint never
// burns a read. Both directions are enforced: the streaming endpoint cannot
// serve an inline note, and the inline endpoints cannot serve a chunked note
// (whose `encryptedData` is an empty buffer).
export async function findReadableNote(
	db: AppDatabase,
	storage: StorageBackend,
	id: string,
	options?: { expect?: "chunked" | "inline" },
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
				...(hasStoredPayload(note) ? { deletion: enqueueDeletion(tx, id) } : {}),
			};
		}

		const isChunked = Boolean(note.chunkCount && note.streamHeader);

		if (options?.expect === "chunked" && !isChunked) {
			return { error: "Note is not a chunked note" as const, status: 400 as const };
		}

		if (options?.expect === "inline" && isChunked) {
			return {
				error: "Note is chunked; read it from /:id/stream" as const,
				status: 400 as const,
			};
		}

		return { note };
	});

	if ("error" in result) {
		if ("deletion" in result) {
			await runDeletion(db, storage, result.deletion);
		}
		httpError(result.status as 400 | 404, result.error);
	}

	return result.note;
}

// Counts one read, deleting the row once readCount reaches maxReads. Call it
// only after the payload is read and decrypted: counted first, a storage error
// or a corrupt blob would burn a burn-after-read note without ever delivering
// it. The row is read again inside the transaction, so a reader that lost the
// race to a concurrent burn gets a 404 — the callback is synchronous on a
// single connection, which is what keeps two readers from both being served.
//
// Returns whether the read burned the note, and the purge the burn queued, for
// the caller to run once the payload is delivered; `purgeDelayMs` holds the
// cleanup job off until then.
export function consumeRead(
	db: AppDatabase,
	id: string,
	purgeDelayMs?: number,
): { burned: boolean; deletion?: PendingDeletion } {
	const result = db.transaction((tx) => {
		const note = tx
			.select({
				readCount: notes.readCount,
				maxReads: notes.maxReads,
				filePath: notes.filePath,
				chunkCount: notes.chunkCount,
			})
			.from(notes)
			.where(eq(notes.id, id))
			.get();

		if (note === undefined) {
			return undefined;
		}

		const maxReads = note.maxReads ?? 0;
		const newReadCount = note.readCount + 1;

		if (maxReads === 0 || newReadCount < maxReads) {
			tx.update(notes).set({ readCount: newReadCount }).where(eq(notes.id, id)).run();
			return { burned: false };
		}

		tx.delete(notes).where(eq(notes.id, id)).run();
		return {
			burned: true,
			...(hasStoredPayload(note) ? { deletion: enqueueDeletion(tx, id, purgeDelayMs) } : {}),
		};
	});

	if (result === undefined) {
		httpError(404, "Note not found");
	}

	return result;
}

export async function consumeNote(
	db: AppDatabase,
	serverKey: Buffer,
	storage: StorageBackend,
	id: string,
) {
	const note = await findReadableNote(db, storage, id, { expect: "inline" });
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
		// Preserve the underlying decryption failure as the HTTPException cause so
		// it can be surfaced in the server log under DEBUG (the client response
		// stays the generic "Failed to decrypt note" — no decryption oracle).
		httpError(500, "Failed to decrypt note", err);
	}

	const { burned, deletion } = consumeRead(db, id);
	if (deletion) {
		await runDeletion(db, storage, deletion);
	}

	return { clientBlob, note, burned };
}
