import { SecretApiError } from "@largerio/secret-sdk";
import { getServerClient } from "#lib/server/client.js";
import { readClientAddress } from "#lib/utils/forwarding.js";
import type { PageServerLoad } from "./$types";

interface NoteInfo {
	hasPassword: boolean;
	maxReads: number;
	/** Null on an instance whose API predates the field. */
	readCount: number | null;
	fileCount: number;
	expiresAt: string;
	chunked: boolean;
	/** 1 for a note with an envelope, read with a proof of the link and the password. */
	format: 0 | 1;
	/** A format 1 password note's wrong passwords left; null for any other note. */
	passwordAttemptsLeft: number | null;
}

interface NoteLoad {
	noteInfo: NoteInfo | null;
	unavailable: boolean;
	rateLimited: boolean;
}

export const load: PageServerLoad = async ({ params, getClientAddress }): Promise<NoteLoad> => {
	const id = params.id;
	if (!id) return { noteInfo: null, unavailable: false, rateLimited: false };

	try {
		const client = await getServerClient(readClientAddress(getClientAddress));
		const info = await client.checkNote(id);

		if (!info.exists) return { noteInfo: null, unavailable: false, rateLimited: false };

		return {
			noteInfo: {
				hasPassword: info.hasPassword,
				maxReads: info.maxReads,
				readCount: info.readCount ?? null,
				fileCount: info.fileCount,
				expiresAt: info.expiresAt,
				chunked: info.chunked,
				format: info.envelope === undefined ? 0 : 1,
				passwordAttemptsLeft: info.passwordAttemptsLeft ?? null,
			},
			unavailable: false,
			rateLimited: false,
		};
	} catch (err) {
		// A 429 is this visitor's own limit, not an outage: the note was neither
		// read nor touched, and a minute is all it takes.
		if (err instanceof SecretApiError && err.status === 429) {
			return { noteInfo: null, unavailable: false, rateLimited: true };
		}
		// An unreachable API is NOT a missing note. Collapsing the two showed
		// "Note not found" during an outage, telling the reader their secret had
		// been destroyed when it was still there.
		return { noteInfo: null, unavailable: true, rateLimited: false };
	}
};
