import { SecretApiError } from "@largerio/secret-sdk";
import type { ServerLoad } from "@sveltejs/kit";
import { getServerClient } from "#lib/server/client.js";
import { readClientAddress } from "#lib/utils/forwarding.js";

export const load: ServerLoad = async ({ params, getClientAddress }) => {
	const id = params["id"];
	if (!id) return { noteInfo: null, unavailable: false, rateLimited: false };

	try {
		const client = await getServerClient(readClientAddress(getClientAddress));
		const info = await client.checkNote(id);

		if (!info.exists) return { noteInfo: null, unavailable: false, rateLimited: false };

		return {
			noteInfo: {
				hasPassword: info.hasPassword,
				maxReads: info.maxReads,
				fileCount: info.fileCount,
				expiresAt: info.expiresAt,
				chunked: info.chunked,
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
