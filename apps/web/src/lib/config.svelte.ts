import type { ServerConfig } from "@secret/shared";
import { MAX_FILE_SIZE, MAX_FILES_PER_NOTE } from "@secret/shared";

const DEFAULT_CONFIG: ServerConfig = {
	appName: "Secret",
	appDescription: "Zero-knowledge encrypted sharing",
	appUrl: "",
	primaryColor: "#6366f1",
	footerText: "",
	ogImageUrl: "",
	maxFileSize: MAX_FILE_SIZE,
	maxFilesPerNote: MAX_FILES_PER_NOTE,
	storageType: "local",
};

let config = $state<ServerConfig>(DEFAULT_CONFIG);

export function setConfig(newConfig: ServerConfig): void {
	config = newConfig;
}

export function getConfig(): ServerConfig {
	return config;
}
