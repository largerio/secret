import { MAX_PASSWORD_ATTEMPTS, NOTE_ID_LENGTH, parseEnvelope } from "@largerio/secret-shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { AppDatabase, Transaction } from "../db/index.js";
import { notes } from "../db/schema.js";
import { enqueueDeletion, type PendingDeletion } from "../pendingDeletions.js";
import { NoteError } from "./errors.js";
import { SEALED_VERIFIER_LENGTH } from "./serverLayer.js";
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
 * Whether a note is a format 1 note, read with its proofs alone. The one
 * definition: a row with an envelope, or with a verifier. One that kept a
 * verifier but lost its envelope is a corrupt format 1 row, never a format 0
 * note: the format 0 reads would serve it, and burn it, to whoever knows its
 * id. format1ReadingOf refuses it.
 */
export function isFormat1(note: {
	readonly envelope: Buffer | null;
	readonly linkVerifier: Buffer | null;
	readonly passwordVerifier: Buffer | null;
}): boolean {
	return note.envelope !== null || note.linkVerifier !== null || note.passwordVerifier !== null;
}

/** What a format 1 row gives its read: how the reader opens it, and what its proofs must match. */
export interface Format1Reading {
	readonly opening: Format1Opening;
	readonly verifiers: SealedVerifiers;
}

/**
 * A format 1 row, checked as its writer's request was: no envelope, one that
 * does not parse or is not of the row's kind, no link verifier, a password
 * verifier on a note without a password or missing on one with it, or a
 * verifier of another length than the server seals, make a corrupt row, never
 * served. Served without its proofs checked, a note would be read, and burned,
 * by whoever knows its id.
 */
export function format1ReadingOf(note: NoteRow): Format1Reading | undefined {
	if (note.envelope === null) {
		return undefined;
	}
	const kind = isChunked(note) ? "chunked" : "single-shot";
	const envelope = parseEnvelope(note.envelope);
	const link = sealedVerifierOf(note.linkVerifier);
	if (envelope?.kind !== kind || link === undefined) {
		return undefined;
	}
	const hasPassword = envelope.argon2 !== undefined;
	if (hasPassword !== (note.passwordVerifier !== null)) {
		return undefined;
	}
	const password = sealedVerifierOf(note.passwordVerifier);
	if (hasPassword && password === undefined) {
		return undefined;
	}
	return {
		opening: { format: 1, envelope: note.envelope },
		verifiers: { link, ...(password ? { password } : {}) },
	};
}

/**
 * A verifier column as the sealed verifier newNoteRow wrote, or undefined when
 * it is NULL or of another length, which only a corrupt row holds: the proofs
 * are compared with HMAC-SHA256 outputs alone.
 */
function sealedVerifierOf(stored: Buffer | null): SealedVerifier | undefined {
	if (stored === null || stored.length !== SEALED_VERIFIER_LENGTH) {
		return undefined;
	}
	return stored as SealedVerifier;
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

// A format 1 password note's attempts are counted the way a smartcard counts
// its PIN's: one is taken, and committed, before the password proof is
// compared (takePasswordAttempt), then settled (settlePasswordAttempt): given
// back to a right password, kept by a wrong one, and the wrong one that
// reaches MAX_PASSWORD_ATTEMPTS deletes the note, as a burn would. Counted only
// once found wrong, an attempt the database could not record (a full disk)
// would cost nothing: guesses would go unlimited, and a right one, which loads
// the note before its read fails, would stand out by its time.

/** What taking a password attempt found. */
export type PasswordAttempt =
	| { readonly status: "taken" }
	| { readonly status: "missing" }
	/** A note without an attempt left, deleted on the way, its purge queued. */
	| { readonly status: "exhausted"; readonly purge: PendingDeletion | undefined };

/**
 * Takes one attempt on a format 1 password note, before its password proof is
 * compared. The count is read again inside the transaction, as spendRead's is,
 * so two attempts at once take two. Each attempt is settled as soon as it is
 * taken, and the last wrong one deletes the note: a note still there without
 * an attempt left is one a crash cut short between the two. It takes no more,
 * and is deleted as its last wrong password would have deleted it.
 */
export function takePasswordAttempt(
	db: AppDatabase,
	id: string,
	purgeDelayMs?: number,
): PasswordAttempt {
	return db.transaction((tx) => {
		const note = attemptsOf(tx, id);
		if (note === undefined) {
			return { status: "missing" };
		}
		if (note.failedAttempts >= MAX_PASSWORD_ATTEMPTS) {
			return { status: "exhausted", purge: removeNote(tx, note, purgeDelayMs) };
		}
		tx.update(notes)
			.set({ failedAttempts: note.failedAttempts + 1 })
			.where(eq(notes.id, id))
			.run();
		return { status: "taken" };
	});
}

/**
 * Settles the attempt takePasswordAttempt took, once the password proof is
 * compared: a right one gets it back, a wrong one keeps it, and deletes the
 * note when it was the last. A note gone meanwhile is refused.
 *
 * Returns whether the attempt deleted the note, and the purge it queued, for
 * the caller to run once the transaction has committed.
 */
export function settlePasswordAttempt(
	db: AppDatabase,
	id: string,
	proven: boolean,
	purgeDelayMs?: number,
): { readonly deleted: boolean; readonly purge: PendingDeletion | undefined } {
	const result = db.transaction((tx) => {
		const note = attemptsOf(tx, id);
		if (note === undefined) {
			return undefined;
		}
		if (proven) {
			tx.update(notes)
				.set({ failedAttempts: note.failedAttempts - 1 })
				.where(eq(notes.id, id))
				.run();
			return { deleted: false, purge: undefined };
		}
		if (note.failedAttempts < MAX_PASSWORD_ATTEMPTS) {
			return { deleted: false, purge: undefined };
		}
		return { deleted: true, purge: removeNote(tx, note, purgeDelayMs) };
	});

	if (result === undefined) {
		throw new NoteError("note_not_found");
	}
	return result;
}

/** What the password attempts read of a note, inside their transaction. */
function attemptsOf(tx: Transaction, id: string) {
	return tx
		.select({
			id: notes.id,
			failedAttempts: notes.failedAttempts,
			filePath: notes.filePath,
			chunkCount: notes.chunkCount,
		})
		.from(notes)
		.where(eq(notes.id, id))
		.get();
}
