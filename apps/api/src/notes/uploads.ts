import { createHash } from "node:crypto";
import { SECRETSTREAM_ABYTES } from "@largerio/secret-crypto/client";
import {
	UPLOAD_ID_LENGTH,
	UPLOAD_SESSION_TTL,
	type UploadSessionMetadata,
	uploadSessionAnyMetadataSchema,
} from "@largerio/secret-shared";
import { asc, count, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { AppDatabase } from "../db/index.js";
import { notes, uploadChunks, uploads } from "../db/schema.js";
import type { AppMetrics } from "../metrics.js";
import { parseJson } from "../parseJson.js";
import { enqueueDeletion, runDeletion } from "../pendingDeletions.js";
import type { StorageBackend } from "../storage/index.js";
import { NoteError } from "./errors.js";
import { sessionSettingsOf } from "./formats.js";
import { assertStorageAvailable, assertWithinLimits, type NotesLimits } from "./limits.js";
import { assertPadded } from "./padding.js";
import { newDeleteToken, newNoteId, newNoteRow, noteExists } from "./rows.js";
import { SEALED_CHUNK_OVERHEAD, type ServerLayer } from "./serverLayer.js";
import type {
	CreatedNote,
	IncomingChunk,
	SealedVerifiers,
	UploadSession,
	UploadSettings,
} from "./types.js";

export interface UploadsDeps {
	readonly db: AppDatabase;
	readonly storage: StorageBackend;
	readonly serverLayer: ServerLayer;
	readonly metrics: AppMetrics;
	readonly limits: NotesLimits;
}

/** Upload sessions: a chunked note arrives chunk by chunk, then becomes a note. */
export interface Uploads {
	openUpload(settings: UploadSettings): UploadSession;
	receiveChunk(chunk: IncomingChunk): Promise<void>;
	completeUpload(uploadId: string): CreatedNote;
}

/**
 * A format 1 session's metadata (uploadSessionFormat1MetadataSchema): the
 * envelope, and the verifiers as the server sealed them. One without a link
 * verifier fails its completion, as a note no proof can open.
 */
interface Format1SessionMetadata {
	readonly envelope: string;
	readonly linkVerifier?: string;
	readonly passwordVerifier?: string;
}

/**
 * What a session keeps of its note's settings: read back, and checked again, on
 * completion. Format 1's verifiers are kept sealed with the note's id and its
 * envelope, as its row will keep them.
 */
function sessionMetadata(
	settings: UploadSettings,
	verifiers: SealedVerifiers | undefined,
): UploadSessionMetadata | Format1SessionMetadata {
	const { opening } = settings;
	if (opening.format === 1) {
		// The envelope says the rest, but for the verifiers, which travel beside it.
		return {
			envelope: opening.envelope.toString("base64"),
			...(verifiers ? { linkVerifier: verifiers.link.toString("base64") } : {}),
			...(verifiers?.password ? { passwordVerifier: verifiers.password.toString("base64") } : {}),
		};
	}
	const metadata: UploadSessionMetadata = {
		streamHeader: opening.streamHeader,
		clientNonce: opening.clientNonce,
		hasPassword: settings.hasPassword,
		expiresIn: settings.expiresIn,
		maxReads: settings.maxReads,
		fileCount: settings.fileCount,
		...(opening.salt ? { salt: opening.salt } : {}),
	};
	return metadata;
}

export function createUploads(deps: UploadsDeps): Uploads {
	const { db, storage, serverLayer, metrics, limits } = deps;

	/** The upload session, refused once it has expired. */
	function findLiveSession(uploadId: string) {
		const session = db.select().from(uploads).where(eq(uploads.id, uploadId)).get();
		if (session === undefined || session.expiresAt < new Date()) {
			throw new NoteError("upload_not_found");
		}
		return session;
	}

	/**
	 * The length of each message a session received, in order: what its chunk
	 * rows record, less what the server's layer added to each.
	 */
	function messageLengthsOf(uploadId: string): number[] {
		return db
			.select({ sizeBytes: uploadChunks.sizeBytes })
			.from(uploadChunks)
			.where(eq(uploadChunks.uploadId, uploadId))
			.orderBy(asc(uploadChunks.chunkIndex))
			.all()
			.map(({ sizeBytes }) => sizeBytes - SEALED_CHUNK_OVERHEAD);
	}

	return {
		openUpload(settings) {
			const maxChunks = Math.ceil(limits.maxChunkedFileSize / limits.chunkSize);
			if (settings.chunkCount > maxChunks) {
				throw new NoteError("too_many_chunks", {
					message: `Maximum ${String(maxChunks)} chunks allowed`,
				});
			}

			assertWithinLimits(limits, settings);

			// Refuse to open a session on a full instance — every chunk would be
			// rejected anyway. Individual chunks are then checked as they arrive.
			assertStorageAvailable(db, limits, 0);

			const uploadId = nanoid(UPLOAD_ID_LENGTH);
			// The note's id comes first: its verifiers are sealed with it, and with
			// the envelope, here already as the row will keep it.
			const noteId = newNoteId();
			const { opening } = settings;
			const verifiers =
				opening.format === 1 && settings.verifiers
					? serverLayer.sealVerifiers(noteId, opening.envelope, settings.verifiers)
					: undefined;
			const now = new Date();
			const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL * 1000);

			db.insert(uploads)
				.values({
					id: uploadId,
					metadata: JSON.stringify(sessionMetadata(settings, verifiers)),
					chunkCount: settings.chunkCount,
					noteId,
					deleteToken: newDeleteToken(),
					createdAt: now,
					expiresAt,
				})
				.run();

			return { uploadId, expiresAt };
		},

		async receiveChunk({ uploadId, index, hash, readBody }) {
			const session = findLiveSession(uploadId);
			if (index >= session.chunkCount) {
				throw new NoteError("chunk_out_of_range");
			}

			const chunk = Buffer.from(await readBody());
			if (chunk.byteLength === 0) {
				throw new NoteError("chunk_empty");
			}
			if (chunk.byteLength > limits.chunkSize + SECRETSTREAM_ABYTES) {
				throw new NoteError("chunk_too_large");
			}
			if (createHash("sha256").update(chunk).digest("hex") !== hash) {
				throw new NoteError("chunk_hash_mismatch");
			}

			const stored = serverLayer.sealChunk(session.noteId, chunk);
			assertStorageAvailable(db, limits, stored.length);
			await storage.saveChunk(session.noteId, index, stored);

			// The session can end while the chunk is written: expired and swept by
			// the cleanup job, or completed by a concurrent completion. Checked again
			// where the chunk is recorded, so a late write is never left behind.
			const outcome = db.transaction((tx) => {
				if (tx.select({ id: uploads.id }).from(uploads).where(eq(uploads.id, uploadId)).get()) {
					tx.insert(uploadChunks)
						.values({ uploadId, chunkIndex: index, sizeBytes: stored.length })
						.onConflictDoUpdate({
							target: [uploadChunks.uploadId, uploadChunks.chunkIndex],
							set: { sizeBytes: stored.length },
						})
						.run();
					return { status: "recorded" as const };
				}
				if (noteExists(tx, session.noteId)) {
					return { status: "completed" as const };
				}
				return { status: "orphaned" as const, purge: enqueueDeletion(tx, session.noteId) };
			});

			if (outcome.status === "completed") {
				throw new NoteError("upload_already_completed");
			}
			if (outcome.status === "orphaned") {
				await runDeletion(db, storage, outcome.purge);
				throw new NoteError("upload_not_found");
			}
		},

		completeUpload(uploadId) {
			const session = findLiveSession(uploadId);

			// A scalar SELECT always yields one row.
			const { received } = db
				.select({ received: count() })
				.from(uploadChunks)
				.where(eq(uploadChunks.uploadId, uploadId))
				.get() as { received: number };
			if (received < session.chunkCount) {
				throw new NoteError("upload_incomplete");
			}

			// Checked again rather than trusted: a corrupted row (bad JSON, missing
			// fields, a broken envelope or verifiers that do not match it) must not
			// produce a malformed note.
			const metadata = parseJson(uploadSessionAnyMetadataSchema, session.metadata);
			if (metadata === undefined) {
				throw new NoteError("upload_corrupted");
			}
			const settings = sessionSettingsOf(metadata);
			// Refused, the session is left as an incomplete one is: its chunks stay
			// in the storage until it expires, and the cleanup job deletes it and
			// purges them.
			if (settings.opening.format === 1) {
				assertPadded(messageLengthsOf(uploadId));
			}

			const row = db.transaction((tx) => {
				if (noteExists(tx, session.noteId)) {
					return undefined;
				}

				// The session's chunk rows are about to cascade away with the uploads
				// row; their total moves onto the note so usage accounting follows the
				// bytes wherever they live.
				const { total } = tx
					.select({ total: sql<number>`COALESCE(SUM(${uploadChunks.sizeBytes}), 0)` })
					.from(uploadChunks)
					.where(eq(uploadChunks.uploadId, uploadId))
					.get() as { total: number };

				const newRow = newNoteRow(
					session.noteId,
					settings,
					{ kind: "chunks", chunkCount: session.chunkCount, size: total },
					session.deleteToken,
					new Date(),
				);
				tx.insert(notes).values(newRow).run();
				tx.delete(uploads).where(eq(uploads.id, uploadId)).run();
				return newRow;
			});

			if (row === undefined) {
				throw new NoteError("upload_already_completed");
			}

			metrics.noteCreated("chunked");
			return { id: session.noteId, expiresAt: row.expiresAt, deleteToken: session.deleteToken };
		},
	};
}
