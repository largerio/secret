import type { ServerLoad } from "@sveltejs/kit";
import { getServerClient } from "$lib/server/client";

export const load: ServerLoad = async ({ params }) => {
	const id = params["id"];
	if (!id) return { noteInfo: null };

	try {
		const client = await getServerClient();
		const info = await client.checkNote(id);

		if (!info.exists) return { noteInfo: null };

		return {
			noteInfo: {
				hasPassword: info.hasPassword,
				maxReads: info.maxReads,
				fileCount: info.fileCount,
				expiresAt: info.expiresAt,
				chunked: info.chunked,
			},
		};
	} catch {
		return { noteInfo: null };
	}
};
