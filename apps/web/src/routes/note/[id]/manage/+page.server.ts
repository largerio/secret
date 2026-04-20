import type { ServerLoad } from "@sveltejs/kit";
import { getServerClient } from "$lib/server/client";

export const load: ServerLoad = async ({ params }) => {
	const id = params["id"];
	if (!id) return { noteExists: false };

	try {
		const client = await getServerClient();
		const info = await client.checkNote(id);
		return { noteExists: info.exists };
	} catch {
		return { noteExists: false };
	}
};
