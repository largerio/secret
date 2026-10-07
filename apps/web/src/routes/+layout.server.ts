import type { ServerLoad } from "@sveltejs/kit";
import { buildServerConfig } from "#lib/server-config.js";
import * as env from "$app/env/private";

export const load: ServerLoad = ({ url, locals }) => {
	const config = buildServerConfig(env, `${url.protocol}//${url.host}`);

	return { config, locale: locals.locale, theme: locals.theme };
};
