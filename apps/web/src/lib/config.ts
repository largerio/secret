export interface AppConfig {
	readonly appName: string;
	readonly appDescription: string;
	readonly primaryColor: string;
	readonly footerText: string;
	readonly ogImageUrl: string;
}

const DEFAULT_CONFIG: AppConfig = {
	appName: "Secret",
	appDescription: "Zero-knowledge encrypted sharing",
	primaryColor: "#6366f1",
	footerText: "",
	ogImageUrl: "",
};

let cachedConfig: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
	if (cachedConfig) return cachedConfig;

	try {
		const res = await fetch("/api/config");
		if (res.ok) {
			cachedConfig = await res.json() as AppConfig;
			return cachedConfig;
		}
	} catch {
		/* fallback to defaults */
	}

	cachedConfig = DEFAULT_CONFIG;
	return cachedConfig;
}

export function getConfig(): AppConfig {
	return cachedConfig ?? DEFAULT_CONFIG;
}
