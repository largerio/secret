import type { ServerLoad } from "@sveltejs/kit";
import { API_TARGET } from "$lib/server/env";

export const load: ServerLoad = async ({ params }) => {
	const id = params["id"];

	try {
		const res = await fetch(`${API_TARGET}/api/v1/notes/${id}/exists`);

		if (!res.ok) {
			return { noteInfo: null };
		}

		const data = await res.json();

		if (!data.exists) {
			return { noteInfo: null };
		}

		return {
			noteInfo: {
				hasPassword: data.hasPassword as boolean,
				maxReads: data.maxReads as number,
				fileCount: data.fileCount as number,
				expiresAt: data.expiresAt as string,
				chunked: data.chunked as boolean,
			},
		};
	} catch {
		return { noteInfo: null };
	}
};
