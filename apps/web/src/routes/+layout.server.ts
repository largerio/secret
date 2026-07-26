import type { ServerLoad } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { buildServerConfig } from "$lib/server-config";

export const load: ServerLoad = ({ url, locals }) => {
	const config = buildServerConfig(env, `${url.protocol}//${url.host}`);

	return { config, locale: locals.locale, theme: locals.theme };
};
