import type { ServerConfig } from "@secret/shared";
import { MAX_FILE_SIZE, MAX_FILES_PER_NOTE } from "@secret/shared";
import type { ServerLoad } from "@sveltejs/kit";

const env = process.env;

export const load: ServerLoad = ({ url }) => {
	const config: ServerConfig = {
		appName: env["APP_NAME"] ?? "Secret",
		appDescription: env["APP_DESCRIPTION"] ?? "Zero-knowledge encrypted sharing",
		appUrl: env["APP_URL"] ?? `${url.protocol}//${url.host}`,
		primaryColor: env["APP_PRIMARY_COLOR"] ?? "#6366f1",
		footerText: env["APP_FOOTER_TEXT"] ?? "",
		ogImageUrl: env["APP_OG_IMAGE_URL"] ?? "",
		maxFileSize: Number(env["MAX_FILE_SIZE"] ?? String(MAX_FILE_SIZE)),
		maxFilesPerNote: Number(env["MAX_FILES_PER_NOTE"] ?? String(MAX_FILES_PER_NOTE)),
		storageType: (env["STORAGE_BACKEND"] ?? "local") as "local" | "s3",
	};

	return { config };
};
