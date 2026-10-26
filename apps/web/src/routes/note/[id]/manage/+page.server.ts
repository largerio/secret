import { getServerClient } from "#lib/server/client.js";
import { readClientAddress } from "#lib/utils/forwarding.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, getClientAddress }) => {
	const id = params.id;
	if (!id) return { noteExists: false };

	try {
		const client = await getServerClient(readClientAddress(getClientAddress));
		const info = await client.checkNote(id);
		return { noteExists: info.exists };
	} catch {
		return { noteExists: false };
	}
};
