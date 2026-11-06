import {
	type ExistingNoteInfo,
	type NoteInfo,
	SecretApiError,
	SecretValidationError,
} from "@largerio/secret-sdk";
import { checkNote } from "#lib/notes/notes.js";

/** What a reader is told of a note before opening it. */
export interface NoteSummary {
	readonly hasPassword: boolean;
	readonly maxReads: number;
	/** Null on an instance whose API predates the field. */
	readonly readCount: number | null;
	readonly fileCount: number;
	readonly expiresAt: string;
	readonly chunked: boolean;
	/** 1 for a note with an envelope, read with a proof of the link and the password. */
	readonly format: 0 | 1;
	/** A format 1 password note's wrong passwords left; null for any other note. */
	readonly passwordAttemptsLeft: number | null;
}

/** Why a note page has no note to offer. */
export type CheckNotice = "not_found" | "unavailable" | "rate_limited";

export type NoteCheck =
	| { readonly kind: "found"; readonly note: NoteSummary }
	| { readonly kind: "notice"; readonly notice: CheckNotice };

export function summarize(info: ExistingNoteInfo): NoteSummary {
	return {
		hasPassword: info.hasPassword,
		maxReads: info.maxReads,
		readCount: info.readCount ?? null,
		fileCount: info.fileCount,
		expiresAt: info.expiresAt,
		chunked: info.chunked,
		format: info.envelope === undefined ? 0 : 1,
		passwordAttemptsLeft: info.passwordAttemptsLeft ?? null,
	};
}

/** Why a check the instance did not answer leaves the page without its note. */
export function checkFailure(error: unknown): CheckNotice {
	// A 429 is this visitor's own limit, not an outage: the note was neither
	// read nor touched, and a minute is all it takes.
	if (error instanceof SecretApiError && error.status === 429) return "rate_limited";
	// An id the instance cannot have given names no note: the SDK refuses it
	// before asking.
	if (error instanceof SecretValidationError) return "not_found";
	// Anything else is NOT a missing note. Collapsing the two showed "Note not
	// found" during an outage, telling the reader their secret had been
	// destroyed when it was still there.
	return "unavailable";
}

/** Asks the instance where a note stands, before the reader opens it: spends nothing. */
export async function checkForReader(
	id: string,
	check: (id: string) => Promise<NoteInfo> = checkNote,
): Promise<NoteCheck> {
	try {
		const info = await check(id);
		return info.exists
			? { kind: "found", note: summarize(info) }
			: { kind: "notice", notice: "not_found" };
	} catch (error) {
		return { kind: "notice", notice: checkFailure(error) };
	}
}

/**
 * Whether the note a deletion link names is still there. A check that fails
 * counts as gone: there is nothing the page could delete.
 */
export async function noteExists(
	id: string,
	check: (id: string) => Promise<NoteInfo> = checkNote,
): Promise<boolean> {
	try {
		return (await check(id)).exists;
	} catch {
		return false;
	}
}
