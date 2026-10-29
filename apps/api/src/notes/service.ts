import { timingSafeEqual } from "node:crypto";
import { MAX_INLINE_ENCRYPTED_SIZE } from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/index.js";
import { notes } from "../db/schema.js";
import type { AppMetrics, NoteType } from "../metrics.js";
import {
	cancelDeletion,
	enqueueDeletion,
	type PendingDeletion,
	runDeletion,
} from "../pendingDeletions.js";
import { type StorageBackend, StorageNotFoundError } from "../storage/index.js";
import { NoteError } from "./errors.js";
import { assertStorageAvailable, assertWithinLimits, type NotesLimits } from "./limits.js";
import {
	isChunked,
	lookUpNote,
	metaOf,
	type NoteRow,
	newDeleteToken,
	newNoteId,
	newNoteRow,
	type PlacementKind,
	placementOf,
	removeNote,
	singleShotPlacement,
	spendRead,
} from "./rows.js";
import { createServerLayer } from "./serverLayer.js";
import { chunkStream } from "./stream.js";
import type { CreatedNote, NoteInfo, NoteRead, NoteSettings, NoteStream } from "./types.js";
import { createUploads, type Uploads } from "./uploads.js";

// How long a file save may run before the cleanup job treats its object as
// abandoned and purges it.
const SAVE_WINDOW_MS = 60 * 60_000;

// How long a stream that burned its note may keep reading chunks before the
// cleanup job purges them: past it, a crash mid-stream no longer strands them.
const STREAM_WINDOW_MS = 24 * 60 * 60_000;

/** The metrics' word for where a note is stored. */
const METRIC_TYPE: Readonly<Record<PlacementKind, NoteType>> = {
	database: "text",
	file: "file",
	chunks: "chunked",
};

export interface NotesServiceDeps {
	readonly db: AppDatabase;
	readonly serverKey: Buffer;
	readonly storage: StorageBackend;
	readonly metrics: AppMetrics;
	readonly limits: NotesLimits;
}

/**
 * Notes and upload sessions: the rules (limits, expiry, reads, burning), the
 * server's encryption layer and where each note is stored. It knows nothing of
 * HTTP: it answers values and refuses with NoteError.
 */
export interface NotesService extends Uploads {
	create(ciphertext: Buffer, settings: NoteSettings): Promise<CreatedNote>;
	/** The note's state, or undefined for a note that is gone. Spends no read. */
	check(id: string): NoteInfo | undefined;
	/** Spends a read on a single-shot note. */
	read(id: string): Promise<NoteRead>;
	/** Spends a read on a chunked note, once its first chunk is loaded. */
	stream(id: string): Promise<NoteStream>;
	delete(id: string, deleteToken: string): Promise<void>;
}

export function createNotesService(deps: NotesServiceDeps): NotesService {
	const { db, storage, metrics, limits } = deps;
	const serverLayer = createServerLayer(deps.serverKey);

	/**
	 * Purge in the background: a reader does not wait on the storage, which a
	 * slow S3 could make take minutes. runDeletion never rejects, and a purge
	 * cut short by a restart stays queued for the cleanup job.
	 */
	function purgeLater(purge: PendingDeletion | undefined): void {
		if (purge) {
			void runDeletion(db, storage, purge);
		}
	}

	/** The note a read is about to be served from. Spends nothing. */
	function readableNote(id: string): NoteRow {
		const lookup = lookUpNote(db, id);
		if (lookup.status === "found") {
			return lookup.note;
		}
		if (lookup.status === "expired") {
			// Counted with the ones the cleanup job deletes, and refused like a note
			// that never existed: a read cannot tell them apart.
			metrics.notesExpired(1);
			purgeLater(lookup.purge);
		}
		throw new NoteError("note_not_found");
	}

	/**
	 * An object of the storage, refused as a missing note when it is gone. Any
	 * other storage failure propagates, to be logged as the error it is.
	 */
	async function loadStored(load: () => Promise<Buffer>): Promise<Buffer> {
		try {
			return await load();
		} catch (err) {
			if (err instanceof StorageNotFoundError) {
				throw new NoteError("note_not_found");
			}
			throw err;
		}
	}

	/**
	 * Writes a file note's sealed ciphertext before its row exists. Its purge is
	 * queued first, so a crash or a failure anywhere until the row is written
	 * leaves a pending deletion instead of an object no row points to; the
	 * insert takes it back.
	 */
	async function saveFile(
		id: string,
		sealed: Buffer,
	): Promise<{ readonly path: string; readonly pending: PendingDeletion }> {
		const pending = db.transaction((tx) => enqueueDeletion(tx, id, SAVE_WINDOW_MS));
		try {
			return { path: await storage.save(id, sealed), pending };
		} catch (err) {
			// A failed write can still leave a partial file behind.
			await runDeletion(db, storage, pending);
			throw err;
		}
	}

	return {
		async create(ciphertext, settings) {
			assertWithinLimits(limits, settings);

			const kind = singleShotPlacement(settings.fileCount);
			// A note in the database is read there synchronously, which blocks the
			// event loop: keep it text-sized. Larger notes belong in the storage.
			if (kind === "database" && ciphertext.byteLength > MAX_INLINE_ENCRYPTED_SIZE) {
				throw new NoteError("note_too_large");
			}

			// The id comes first: the server layer binds the sealed bytes to it.
			const id = newNoteId();
			const { sealed, iv } = serverLayer.sealSingleShot(id, ciphertext);

			// Checked against the stored size before anything is written, so a full
			// instance refuses cleanly instead of failing half-way.
			assertStorageAvailable(db, limits, sealed.length);

			const deleteToken = newDeleteToken();
			const now = new Date();
			const file = kind === "file" ? await saveFile(id, sealed) : undefined;
			const row = newNoteRow(
				id,
				settings,
				file
					? { kind: "file", path: file.path, iv, size: sealed.length }
					: { kind: "database", sealed, iv },
				deleteToken,
				now,
			);

			try {
				db.transaction((tx) => {
					tx.insert(notes).values(row).run();
					if (file) {
						cancelDeletion(tx, file.pending);
					}
				});
			} catch (err) {
				// Disk full, SQLITE_BUSY, corruption: the file has no row to belong to.
				if (file) {
					await runDeletion(db, storage, file.pending);
				}
				throw err;
			}

			metrics.noteCreated(METRIC_TYPE[kind]);
			return { id, expiresAt: row.expiresAt, deleteToken };
		},

		check(id) {
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
				return undefined;
			}

			const maxReads = note.maxReads ?? 0;
			return {
				hasPassword: note.hasPassword,
				fileCount: note.fileCount,
				expiresAt: note.expiresAt,
				maxReads,
				// The count only matters against a limit. An unlimited note keeps
				// counting forever, and reporting that would hand anyone holding the
				// link a live view counter, so it stays at 0.
				readCount: maxReads > 0 ? note.readCount : 0,
				chunked: isChunked(note),
			};
		},

		async read(id) {
			const note = readableNote(id);
			if (isChunked(note)) {
				throw new NoteError("note_is_chunked");
			}

			const { filePath } = note;
			const sealed =
				filePath === null ? note.encryptedData : await loadStored(() => storage.read(filePath));
			let ciphertext: Buffer;
			try {
				ciphertext = serverLayer.openSingleShot(
					id,
					sealed,
					Buffer.from(note.serverNonce, "base64"),
				);
			} catch (err) {
				// The client gets the generic message, never the cause: no oracle.
				throw new NoteError("note_corrupted", { cause: err });
			}

			const { burned, purge } = spendRead(db, id);
			// The ciphertext is in memory already: the answer does not wait for it.
			purgeLater(purge);
			metrics.noteRead(METRIC_TYPE[placementOf(note)], burned);

			return { meta: metaOf(note), ciphertext };
		},

		async stream(id) {
			const note = readableNote(id);
			if (!isChunked(note)) {
				throw new NoteError("note_is_single_shot");
			}
			// Everything the answer needs is checked before the read is spent: a
			// chunked row without its stream header (a corrupt row) cannot be read.
			const { streamHeader, chunkCount } = note;
			if (!streamHeader) {
				throw new NoteError("note_corrupted");
			}

			// The first chunk is loaded and opened before the read counts, so a
			// missing or corrupt note is refused and left intact. Once the answer
			// has started, a later failure can only break the stream.
			const storedHead = await loadStored(() => storage.readChunk(id, 0));
			let head: Buffer;
			try {
				head = serverLayer.openChunk(id, storedHead);
			} catch (err) {
				throw new NoteError("note_corrupted", { cause: err });
			}

			const { burned, purge } = spendRead(db, id, STREAM_WINDOW_MS);
			metrics.noteRead("chunked", burned);

			return {
				meta: metaOf(note),
				streamHeader,
				chunkCount,
				chunks: chunkStream({
					count: chunkCount,
					first: head,
					load: async (index) => serverLayer.openChunk(id, await storage.readChunk(id, index)),
					// The read is spent: the purge runs whatever becomes of the stream.
					onEnd: async () => {
						if (purge) {
							await runDeletion(db, storage, purge);
						}
					},
				}),
			};
		},

		async delete(id, deleteToken) {
			const outcome = db.transaction((tx) => {
				const note = tx
					.select({
						id: notes.id,
						filePath: notes.filePath,
						chunkCount: notes.chunkCount,
						deleteToken: notes.deleteToken,
					})
					.from(notes)
					.where(eq(notes.id, id))
					.get();
				if (note === undefined) {
					return { status: "missing" as const };
				}

				const given = Buffer.from(deleteToken);
				const expected = Buffer.from(note.deleteToken);
				if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
					return { status: "refused" as const };
				}

				return { status: "deleted" as const, purge: removeNote(tx, note) };
			});

			if (outcome.status === "missing") {
				throw new NoteError("note_not_found");
			}
			if (outcome.status === "refused") {
				throw new NoteError("wrong_delete_token");
			}
			// Awaited, unlike a burn's purge: "deleted" means erased.
			if (outcome.purge) {
				await runDeletion(db, storage, outcome.purge);
			}
			metrics.noteDeleted();
		},

		...createUploads({ db, storage, serverLayer, metrics, limits }),
	};
}
