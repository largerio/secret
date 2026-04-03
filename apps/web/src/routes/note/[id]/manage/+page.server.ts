import type { ServerLoad } from "@sveltejs/kit";
import { API_TARGET } from "$lib/server/env";

export const load: ServerLoad = async ({ params }) => {
	const id = params["id"];

	try {
		const res = await fetch(`${API_TARGET}/api/v1/notes/${id}/exists`);

		if (!res.ok) {
			return { noteExists: false };
		}

		const data = await res.json();
		return { noteExists: data.exists === true };
	} catch {
		return { noteExists: false };
	}
};
