import type { ServerLoad } from "@sveltejs/kit";
import { getServerClient } from "#lib/server/client.js";
import { readClientAddress } from "#lib/utils/forwarding.js";

export const load: ServerLoad = async ({ params, getClientAddress }) => {
	const id = params["id"];
	if (!id) return { noteExists: false };

	try {
		const client = await getServerClient(readClientAddress(getClientAddress));
		const info = await client.checkNote(id);
		return { noteExists: info.exists };
	} catch {
		return { noteExists: false };
	}
};
