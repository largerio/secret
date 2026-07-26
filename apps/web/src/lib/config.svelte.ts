import type { ServerConfig } from "@largerio/secret-shared";
import {
	DEFAULT_CHUNK_SIZE,
	DEFAULT_MAX_CHUNKED_SIZE,
	MAX_EXPIRY_SECONDS,
	MAX_FILE_SIZE,
	MAX_FILES_PER_NOTE,
} from "@largerio/secret-shared";

const DEFAULT_CONFIG: ServerConfig = {
	appName: "Secret",
	appDescription: "Zero-knowledge encrypted sharing",
	appUrl: "",
	primaryColor: "#6366f1",
	footerText: "",
	ogImageUrl: "",
	maxFileSize: MAX_FILE_SIZE,
	maxFilesPerNote: MAX_FILES_PER_NOTE,
	chunkSize: DEFAULT_CHUNK_SIZE,
	maxChunkedFileSize: DEFAULT_MAX_CHUNKED_SIZE,
	maxExpiry: MAX_EXPIRY_SECONDS,
};

let config = $state<ServerConfig>(DEFAULT_CONFIG);

export function setConfig(newConfig: ServerConfig): void {
	config = newConfig;
}

export function getConfig(): ServerConfig {
	return config;
}
