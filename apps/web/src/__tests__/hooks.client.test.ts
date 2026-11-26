import { SHELL_DATA_ID, serializeShellData } from "@largerio/secret-shared/site";
import { afterEach, describe, expect, it, vi } from "vitest";
import ko from "../../../../messages/ko.json";
import { init } from "../hooks.client.js";
import { DEFAULT_CONFIG, getConfig, setConfig } from "../lib/config.svelte.js";
import { serveMessages } from "../lib/i18n/__tests__/messages.js";
import { getLocale, setLocale, t } from "../lib/i18n/index.svelte.js";
import { getMode } from "../lib/theme.svelte.js";

afterEach(() => {
	document.getElementById(SHELL_DATA_ID)?.remove();
	setConfig(DEFAULT_CONFIG);
	setLocale("en");
	vi.unstubAllGlobals();
});

describe("init", () => {
	it("starts the app from the shell data the server wrote, its language loaded", async () => {
		const config = { ...DEFAULT_CONFIG, appName: "Vault" };
		const script = document.createElement("script");
		script.type = "application/json";
		script.id = SHELL_DATA_ID;
		script.textContent = serializeShellData({ config, locale: "ko", theme: "dark" });
		document.head.append(script);
		vi.stubGlobal("fetch", vi.fn(serveMessages));

		// SvelteKit renders nothing before it resolves.
		await init();

		expect(getConfig()).toEqual(config);
		expect(getLocale()).toBe("ko");
		expect(t("lang_label")).toBe(ko.lang_label);
		expect(getMode()).toBe("dark");
	});
});
