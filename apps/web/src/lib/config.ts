import { MAX_FILE_SIZE, MAX_FILES_PER_NOTE } from "@secret/shared";
import type { ServerConfig } from "@secret/shared";

const DEFAULT_CONFIG: ServerConfig = {
	appName: "Secret",
	appDescription: "Zero-knowledge encrypted sharing",
	primaryColor: "#6366f1",
	footerText: "",
	ogImageUrl: "",
	maxFileSize: MAX_FILE_SIZE,
	maxFilesPerNote: MAX_FILES_PER_NOTE,
	storageType: "local",
};

let cachedConfig: ServerConfig | null = null;

export async function loadConfig(): Promise<ServerConfig> {
	if (cachedConfig) return cachedConfig;

	try {
		const res = await fetch("/api/config");
		if (res.ok) {
			cachedConfig = await res.json() as ServerConfig;
			return cachedConfig;
		}
	} catch {
		/* fallback to defaults */
	}

	cachedConfig = DEFAULT_CONFIG;
	return cachedConfig;
}

export function getConfig(): ServerConfig {
	return cachedConfig ?? DEFAULT_CONFIG;
}
