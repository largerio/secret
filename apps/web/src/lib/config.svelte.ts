import {
	DEFAULT_CHUNK_SIZE,
	DEFAULT_MAX_CHUNKED_SIZE,
	MAX_EXPIRY_SECONDS,
	MAX_FILE_SIZE,
	MAX_FILES_PER_NOTE,
} from "@largerio/secret-shared";
import type { PageConfig } from "@largerio/secret-shared/site";

/** An instance's settings when it sets none, which a page the server did not render starts from. */
export const DEFAULT_CONFIG: PageConfig = {
	appName: "Secret",
	footerText: "",
	maxFileSize: MAX_FILE_SIZE,
	maxFilesPerNote: MAX_FILES_PER_NOTE,
	chunkSize: DEFAULT_CHUNK_SIZE,
	maxChunkedFileSize: DEFAULT_MAX_CHUNKED_SIZE,
	maxExpiry: MAX_EXPIRY_SECONDS,
};

let config = $state<PageConfig>(DEFAULT_CONFIG);

export function setConfig(newConfig: PageConfig): void {
	config = newConfig;
}

export function getConfig(): PageConfig {
	return config;
}
