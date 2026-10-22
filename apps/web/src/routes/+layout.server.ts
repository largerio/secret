import type { ServerLoad } from "@sveltejs/kit";
import { buildServerConfig } from "#lib/server-config.js";
import { accentStyle } from "#lib/utils/accent.js";
import * as env from "$app/env/private";

export const load: ServerLoad = ({ url, locals }) => {
	const config = buildServerConfig(env, `${url.protocol}//${url.host}`);
	// Rendered on <html> by hooks.server.ts: the whole page, its background
	// included, follows APP_PRIMARY_COLOR.
	locals.accent = accentStyle(config.primaryColor) ?? "";

	return { config, locale: locals.locale, theme: locals.theme };
};
