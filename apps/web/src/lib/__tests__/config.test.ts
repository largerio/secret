import type { ServerConfig } from "@largerio/shared";
import {
	DEFAULT_CHUNK_SIZE,
	DEFAULT_MAX_CHUNKED_SIZE,
	MAX_FILE_SIZE,
	MAX_FILES_PER_NOTE,
} from "@largerio/shared";
import { describe, expect, it } from "vitest";
import { getConfig, setConfig } from "../config.svelte.js";

describe("config store", () => {
	it("exposes built-in defaults before any injection", () => {
		const config = getConfig();
		expect(config.appName).toBe("Secret");
		expect(config.maxFileSize).toBe(MAX_FILE_SIZE);
		expect(config.maxFilesPerNote).toBe(MAX_FILES_PER_NOTE);
		expect(config.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
		expect(config.maxChunkedFileSize).toBe(DEFAULT_MAX_CHUNKED_SIZE);
	});

	it("replaces the active config via setConfig", () => {
		const injected: ServerConfig = {
			appName: "My Vault",
			appDescription: "Custom instance",
			appUrl: "https://vault.example",
			primaryColor: "#ff0000",
			footerText: "© 2026",
			ogImageUrl: "https://vault.example/og.png",
			maxFileSize: 1234,
			maxFilesPerNote: 3,
			chunkSize: 5678,
			maxChunkedFileSize: 90000,
		};

		setConfig(injected);

		expect(getConfig()).toEqual(injected);
	});
});
