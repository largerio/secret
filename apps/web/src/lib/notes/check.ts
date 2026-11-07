import {
	type ExistingNoteInfo,
	type NoteInfo,
	SecretApiError,
	SecretValidationError,
} from "@largerio/secret-sdk";
import type { IconName } from "#lib/components/Icon.svelte";
import type { MessageKey } from "#lib/i18n/index.svelte.js";
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

/** Why a note's page has no note to offer. */
export type CheckNotice = "not_found" | "unavailable" | "rate_limited";

export type NoteCheck =
	| { readonly kind: "found"; readonly note: NoteSummary }
	| { readonly kind: "notice"; readonly notice: CheckNotice };

/** A notice of a note's pages, the link's own included: a key cut off in transit. */
export type LinkNotice = CheckNotice | "link_incomplete";

/** What a page shows for a notice. */
export interface NoticeText {
	readonly title: MessageKey;
	readonly body: MessageKey;
	readonly icon: IconName;
}

export const NOTICES: Readonly<Record<LinkNotice, NoticeText>> = {
	not_found: { title: "not_found_title", body: "not_found_description", icon: "file-x" },
	link_incomplete: {
		title: "link_incomplete_title",
		body: "link_incomplete_description",
		icon: "link",
	},
	unavailable: { title: "unavailable_title", body: "unavailable_description", icon: "alert" },
	rate_limited: { title: "rate_limited_title", body: "rate_limited_description", icon: "clock" },
};

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
	// found" during an outage: the reader was told their secret was destroyed,
	// and the creator that the leaked link they came to revoke was dead, while
	// the note could still be read.
	return "unavailable";
}

/**
 * Asks the instance where the note a link names stands, for the page that
 * reads it and the one that deletes it: spends nothing.
 */
export async function checkNoteLink(
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
