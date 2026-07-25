import type { ServerLoad } from "@sveltejs/kit";
import { getServerClient } from "$lib/server/client";

export const load: ServerLoad = async ({ params }) => {
	const id = params["id"];
	if (!id) return { noteInfo: null, unavailable: false };

	try {
		const client = await getServerClient();
		const info = await client.checkNote(id);

		if (!info.exists) return { noteInfo: null, unavailable: false };

		return {
			noteInfo: {
				hasPassword: info.hasPassword,
				maxReads: info.maxReads,
				fileCount: info.fileCount,
				expiresAt: info.expiresAt,
				chunked: info.chunked,
			},
			unavailable: false,
		};
	} catch {
		// An unreachable API is NOT a missing note. Collapsing the two showed
		// "Note not found" during an outage, telling the reader their secret had
		// been destroyed when it was still there.
		return { noteInfo: null, unavailable: true };
	}
};
