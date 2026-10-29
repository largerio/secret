import { MAX_PASSWORD_ATTEMPTS, NOTE_ID_LENGTH, parseEnvelope } from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { AppDatabase, Transaction } from "../db/index.js";
import { notes } from "../db/schema.js";
import { enqueueDeletion, type PendingDeletion } from "../pendingDeletions.js";
import { NoteError } from "./errors.js";
import type {
	ChunkedFormat0Opening,
	Format0Opening,
	Format1Opening,
	NoteMeta,
	NoteOpening,
	SealedVerifier,
	SealedVerifiers,
	StoredSettings,
} from "./types.js";

export type NoteRow = typeof notes.$inferSelect;

const DELETE_TOKEN_LENGTH = 32;

export function newNoteId(): string {
	return nanoid(NOTE_ID_LENGTH);
}

export function newDeleteToken(): string {
	return nanoid(DELETE_TOKEN_LENGTH);
}

/** Where a note keeps its sealed ciphertext. */
export type PlacementKind = "database" | "file" | "chunks";

/** Where a new note's sealed ciphertext went, as its row records it. */
export type Placement =
	| { readonly kind: "database"; readonly sealed: Buffer; readonly iv: Buffer }
	| { readonly kind: "file"; readonly path: string; readonly iv: Buffer; readonly size: number }
	| { readonly kind: "chunks"; readonly chunkCount: number; readonly size: number };

/**
 * Whether a note is a chunked note, its ciphertext a series of chunks in the
 * storage. The one definition: reads, the existence check and purges all ask
 * it here.
 */
export function isChunked<T extends { readonly chunkCount: number | null }>(
	note: T,
): note is T & { readonly chunkCount: number } {
	return (note.chunkCount ?? 0) > 0;
}

/**
 * Whether a note is a format 1 note, its settings and what opening it takes in
 * the envelope its writer sent. The one definition: a row without one is
 * format 0.
 */
export function isFormat1<T extends { readonly envelope: Buffer | null }>(
	note: T,
): note is T & { readonly envelope: Buffer } {
	return note.envelope !== null;
}

/** What a format 1 row gives its read: how the reader opens it, and what its proofs must match. */
export interface Format1Reading {
	readonly opening: Format1Opening;
	readonly verifiers: SealedVerifiers;
}

/**
 * A format 1 row, checked as its writer's request was: an envelope that does
 * not parse or is not of the row's kind, no link verifier, or a password
 * verifier on a note without a password or missing on one with it, make a
 * corrupt row, never served. Served without its proofs checked, a note would
 * be read, and burned, by whoever knows its id.
 */
export function format1ReadingOf(
	note: NoteRow & { readonly envelope: Buffer },
): Format1Reading | undefined {
	const kind = isChunked(note) ? "chunked" : "single-shot";
	const envelope = parseEnvelope(note.envelope);
	const { linkVerifier, passwordVerifier } = note;
	if (envelope?.kind !== kind || linkVerifier === null) {
		return undefined;
	}
	if ((envelope.argon2 !== undefined) !== (passwordVerifier !== null)) {
		return undefined;
	}
	// The columns hold what newNoteRow wrote: verifiers the server sealed.
	return {
		opening: { format: 1, envelope: note.envelope },
		verifiers: {
			link: linkVerifier as SealedVerifier,
			...(passwordVerifier !== null ? { password: passwordVerifier as SealedVerifier } : {}),
		},
	};
}

/** How a reader opens a format 0 single-shot note: the fields its writer sent. */
export function openingOf(note: NoteRow): Format0Opening {
	return {
		format: 0,
		clientNonce: note.clientNonce,
		...(note.salt !== null ? { salt: note.salt } : {}),
	};
}

/**
 * How a reader opens a format 0 chunked note, or undefined for a corrupt row:
 * one without its stream header.
 */
export function chunkedOpeningOf(note: NoteRow): ChunkedFormat0Opening | undefined {
	if (!note.streamHeader) {
		return undefined;
	}
	return { ...openingOf(note), streamHeader: note.streamHeader };
}

export function placementOf(note: {
	readonly filePath: string | null;
	readonly chunkCount: number | null;
}): PlacementKind {
	if (isChunked(note)) {
		return "chunks";
	}
	return note.filePath === null ? "database" : "file";
}

/** Whether a note keeps objects in the storage, to purge once it goes. */
export function inStorage(note: {
	readonly filePath: string | null;
	readonly chunkCount: number | null;
}): boolean {
	return placementOf(note) !== "database";
}

/**
 * Where a new single-shot note's ciphertext goes: the one decision. A note
 * without files stays in its database row: small (the service caps it), and
 * readable while the storage is down. A note with files goes to the storage.
 */
export function singleShotPlacement(fileCount: number): "database" | "file" {
	return fileCount === 0 ? "database" : "file";
}

/**
 * The row of a new note: the one place a note row is built. Its verifiers are
 * the sealed ones: a writer's never reach a row.
 */
export function newNoteRow(
	id: string,
	settings: StoredSettings,
	placement: Placement,
	deleteToken: string,
	now: Date,
): typeof notes.$inferInsert {
	const common = {
		id,
		...openingColumns(settings.opening),
		linkVerifier: settings.verifiers?.link ?? null,
		passwordVerifier: settings.verifiers?.password ?? null,
		hasPassword: settings.hasPassword,
		deleteToken,
		fileCount: settings.fileCount,
		expiresAt: new Date(now.getTime() + settings.expiresIn * 1000),
		maxReads: settings.maxReads,
		createdAt: now,
	};
	switch (placement.kind) {
		case "database":
			return {
				...common,
				encryptedData: placement.sealed,
				serverNonce: placement.iv.toString("base64"),
				filePath: null,
				sizeBytes: placement.sealed.length,
			};
		case "file":
			return {
				...common,
				encryptedData: Buffer.alloc(0),
				serverNonce: placement.iv.toString("base64"),
				filePath: placement.path,
				sizeBytes: placement.size,
			};
		case "chunks":
			return {
				...common,
				encryptedData: Buffer.alloc(0),
				serverNonce: "",
				filePath: null,
				chunkCount: placement.chunkCount,
				sizeBytes: placement.size,
			};
	}
}

/** The columns that tell how to open a note: its envelope, or format 0's own. */
function openingColumns(opening: NoteOpening) {
	if (opening.format === 1) {
		// The envelope holds it all. client_nonce is NOT NULL: it stays empty.
		return { envelope: opening.envelope, clientNonce: "", salt: null, streamHeader: null };
	}
	return {
		envelope: null,
		clientNonce: opening.clientNonce,
		salt: opening.salt ?? null,
		streamHeader: opening.streamHeader ?? null,
	};
}

/** What comes with a note's ciphertext, opened as `opening` says. */
export function metaOf<Opening extends NoteOpening>(
	note: NoteRow,
	opening: Opening,
): NoteMeta<Opening> {
	return {
		hasPassword: note.hasPassword,
		fileCount: note.fileCount,
		createdAt: note.createdAt,
		expiresAt: note.expiresAt,
		opening,
	};
}

export function noteExists(db: AppDatabase | Transaction, id: string): boolean {
	return db.select({ id: notes.id }).from(notes).where(eq(notes.id, id)).get() !== undefined;
}

/**
 * Deletes a note's row, and queues the purge of what it keeps in the storage
 * in the same transaction, so a crash before the purge leaves it for the
 * cleanup job. The caller runs the purge after the commit.
 */
export function removeNote(
	tx: Transaction,
	note: {
		readonly id: string;
		readonly filePath: string | null;
		readonly chunkCount: number | null;
	},
	purgeDelayMs?: number,
): PendingDeletion | undefined {
	tx.delete(notes).where(eq(notes.id, note.id)).run();
	return inStorage(note) ? enqueueDeletion(tx, note.id, purgeDelayMs) : undefined;
}

export type NoteLookup =
	| { readonly status: "found"; readonly note: NoteRow }
	| { readonly status: "missing" }
	| { readonly status: "expired"; readonly purge: PendingDeletion | undefined };

/**
 * The note a read is about to be served from. An expired note is deleted on
 * the way, with its purge queued, and reported apart so it can be counted.
 */
export function lookUpNote(db: AppDatabase, id: string): NoteLookup {
	return db.transaction((tx) => {
		const note = tx.select().from(notes).where(eq(notes.id, id)).get();
		if (note === undefined) {
			return { status: "missing" };
		}
		if (note.expiresAt < new Date()) {
			return { status: "expired", purge: removeNote(tx, note) };
		}
		return { status: "found", note };
	});
}

// Counts one read, deleting the row once readCount reaches maxReads. Call it
// only after the ciphertext is loaded and opened: counted first, a storage
// error or corrupt bytes would burn a burn-after-read note without ever
// delivering it. The row is read again inside the transaction, so a reader
// that lost the race to a concurrent burn gets a refusal — the callback is
// synchronous on a single connection, which is what keeps two readers from
// both being served.
//
// Returns whether the read burned the note, and the purge the burn queued, for
// the caller to run once the ciphertext is delivered; `purgeDelayMs` holds the
// cleanup job off until then.
export function spendRead(
	db: AppDatabase,
	id: string,
	purgeDelayMs?: number,
): { readonly burned: boolean; readonly purge: PendingDeletion | undefined } {
	const result = db.transaction((tx) => {
		const note = tx
			.select({
				id: notes.id,
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
		const readCount = note.readCount + 1;
		if (maxReads === 0 || readCount < maxReads) {
			tx.update(notes).set({ readCount }).where(eq(notes.id, id)).run();
			return { burned: false, purge: undefined };
		}

		return { burned: true, purge: removeNote(tx, note, purgeDelayMs) };
	});

	if (result === undefined) {
		throw new NoteError("note_not_found");
	}
	return result;
}

// Counts one wrong password on a format 1 note, deleting the row on the
// attempt that reaches MAX_PASSWORD_ATTEMPTS, as a burn would. The count is
// read again inside the transaction, as spendRead's is, so two wrong passwords
// at once count two, and a note burned or deleted meanwhile is refused.
//
// Returns whether the attempt deleted the note, and the purge it queued, for
// the caller to run once the transaction has committed.
export function countFailedAttempt(
	db: AppDatabase,
	id: string,
): { readonly deleted: boolean; readonly purge: PendingDeletion | undefined } {
	const result = db.transaction((tx) => {
		const note = tx
			.select({
				id: notes.id,
				failedAttempts: notes.failedAttempts,
				filePath: notes.filePath,
				chunkCount: notes.chunkCount,
			})
			.from(notes)
			.where(eq(notes.id, id))
			.get();

		if (note === undefined) {
			return undefined;
		}

		const failedAttempts = note.failedAttempts + 1;
		if (failedAttempts < MAX_PASSWORD_ATTEMPTS) {
			tx.update(notes).set({ failedAttempts }).where(eq(notes.id, id)).run();
			return { deleted: false, purge: undefined };
		}

		return { deleted: true, purge: removeNote(tx, note) };
	});

	if (result === undefined) {
		throw new NoteError("note_not_found");
	}
	return result;
}
