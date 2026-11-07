import { SHELL_DATA_ID, serializeShellData } from "@largerio/secret-shared/site";
import { afterEach, describe, expect, it } from "vitest";
import { init } from "../hooks.client.js";
import { DEFAULT_CONFIG, getConfig, setConfig } from "../lib/config.svelte.js";
import { getLocale, setLocale } from "../lib/i18n/index.svelte.js";
import { getMode } from "../lib/theme.svelte.js";

afterEach(() => {
	document.getElementById(SHELL_DATA_ID)?.remove();
	setConfig(DEFAULT_CONFIG);
	setLocale("en");
});

describe("init", () => {
	it("starts the app from the shell data the server wrote", async () => {
		const config = { ...DEFAULT_CONFIG, appName: "Vault" };
		const script = document.createElement("script");
		script.type = "application/json";
		script.id = SHELL_DATA_ID;
		script.textContent = serializeShellData({ config, locale: "ko", theme: "dark" });
		document.head.append(script);

		await init();

		expect(getConfig()).toEqual(config);
		expect(getLocale()).toBe("ko");
		expect(getMode()).toBe("dark");
	});
});
