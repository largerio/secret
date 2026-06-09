import type { ServerConfig } from "@largerio/shared";
import {
	DEFAULT_CHUNK_SIZE,
	DEFAULT_MAX_CHUNKED_SIZE,
	MAX_FILE_SIZE,
	MAX_FILES_PER_NOTE,
} from "@largerio/shared";
import type { ServerLoad } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

export const load: ServerLoad = ({ url, locals }) => {
	const config: ServerConfig = {
		appName: env["APP_NAME"] ?? "Secret",
		appDescription: env["APP_DESCRIPTION"] ?? "Zero-knowledge encrypted sharing",
		appUrl: env["APP_URL"] ?? `${url.protocol}//${url.host}`,
		primaryColor: env["APP_PRIMARY_COLOR"] ?? "#6366f1",
		footerText: env["APP_FOOTER_TEXT"] ?? "",
		ogImageUrl: env["APP_OG_IMAGE_URL"] ?? "",
		maxFileSize: Number(env["MAX_FILE_SIZE"] ?? String(MAX_FILE_SIZE)),
		maxFilesPerNote: Number(env["MAX_FILES_PER_NOTE"] ?? String(MAX_FILES_PER_NOTE)),
		chunkSize: Number(env["CHUNK_SIZE"] ?? String(DEFAULT_CHUNK_SIZE)),
		maxChunkedFileSize: Number(env["MAX_CHUNKED_FILE_SIZE"] ?? String(DEFAULT_MAX_CHUNKED_SIZE)),
	};

	return { config, locale: locals.locale, theme: locals.theme };
};
