import {
	type PageConfig,
	SHELL_DATA_ID,
	type ShellData,
	serializeShellData,
} from "@largerio/secret-shared/site";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, getConfig, setConfig } from "../config.svelte.js";
import { getLocale, setLocale } from "../i18n/index.svelte.js";
import { fetchInstanceLimits, localShellData, servedShellData, startPage } from "../shell.js";
import { getMode } from "../theme.svelte.js";

const INSTANCE: PageConfig = {
	...DEFAULT_CONFIG,
	appName: "Vault",
	footerText: "© Vault",
	maxExpiry: 3600,
};

/** Writes the shell data into the page, as the server does. */
function serve(text: string): void {
	const script = document.createElement("script");
	script.type = "application/json";
	script.id = SHELL_DATA_ID;
	script.textContent = text;
	document.head.append(script);
}

function setCookie(name: string, value: string): void {
	// biome-ignore lint/suspicious/noDocumentCookie: what the page reads
	document.cookie = `${name}=${value}; path=/`;
}

function clearCookie(name: string): void {
	// biome-ignore lint/suspicious/noDocumentCookie: what the page reads
	document.cookie = `${name}=; path=/; max-age=0`;
}

/** A fetch that answers `/api/v1/config` with `body`. */
function answering(body: unknown, init?: ResponseInit) {
	return vi.fn<typeof fetch>(async () => Response.json(body, init));
}

afterEach(() => {
	document.getElementById(SHELL_DATA_ID)?.remove();
	clearCookie("secret_lang");
	clearCookie("secret_theme");
	setConfig(DEFAULT_CONFIG);
	setLocale("en");
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("servedShellData", () => {
	it("reads what the server wrote into the shell", () => {
		const data: ShellData = { config: INSTANCE, locale: "fr", theme: "dark" };
		serve(serializeShellData(data));
		expect(servedShellData(document)).toEqual(data);
	});

	it("is undefined for a page the server did not fill in, or filled in badly", () => {
		expect(servedShellData(document)).toBeUndefined();
		serve("{not json");
		expect(servedShellData(document)).toBeUndefined();
	});
});

describe("localShellData", () => {
	it("takes the visitor's choices from their cookies, as the server would", () => {
		setCookie("secret_lang", "de");
		setCookie("secret_theme", "light");
		expect(localShellData(document)).toEqual({
			config: DEFAULT_CONFIG,
			locale: "de",
			theme: "light",
		});
	});

	it("falls back on the browser's languages and the OS theme", () => {
		vi.stubGlobal("navigator", { language: "ja-JP", languages: ["ja-JP"] });
		setCookie("secret_lang", "xx");
		setCookie("secret_theme", "blue");
		expect(localShellData(document)).toEqual({
			config: DEFAULT_CONFIG,
			locale: "ja",
			theme: "system",
		});
	});
});

describe("fetchInstanceLimits", () => {
	it("asks the API for the instance's limits", async () => {
		const fetcher = answering({
			maxFileSize: 1000,
			maxFilesPerNote: 2,
			maxExpiry: 3600,
			chunkSize: 512,
			maxChunkedFileSize: 4000,
		});
		await expect(fetchInstanceLimits(fetcher)).resolves.toEqual({
			maxFileSize: 1000,
			maxFilesPerNote: 2,
			maxExpiry: 3600,
			chunkSize: 512,
			maxChunkedFileSize: 4000,
		});
		expect(fetcher).toHaveBeenCalledWith("/api/v1/config");
	});

	it("keeps only what is a limit, and nothing else the answer holds", async () => {
		const fetcher = answering({
			maxFileSize: "20MB",
			maxFilesPerNote: 0,
			maxExpiry: 7.5,
			chunkSize: -1,
			maxChunkedFileSize: 4000,
			appName: "Not a limit",
		});
		await expect(fetchInstanceLimits(fetcher)).resolves.toEqual({ maxChunkedFileSize: 4000 });
	});

	it("leaves the defaults when the API cannot be asked", async () => {
		await expect(
			fetchInstanceLimits(answering({ maxExpiry: 3600 }, { status: 502 })),
		).resolves.toEqual({});
		await expect(fetchInstanceLimits(answering(null))).resolves.toEqual({});
		await expect(fetchInstanceLimits(answering("3600"))).resolves.toEqual({});
		const unreachable = vi.fn<typeof fetch>(async () => {
			throw new TypeError("fetch failed");
		});
		await expect(fetchInstanceLimits(unreachable)).resolves.toEqual({});
		const notJson = vi.fn<typeof fetch>(async () => new Response("<html>"));
		await expect(fetchInstanceLimits(notJson)).resolves.toEqual({});
	});
});

describe("startPage", () => {
	it("starts from the shell data, and asks nothing more", () => {
		serve(serializeShellData({ config: INSTANCE, locale: "fr", theme: "dark" }));
		const fetcher = answering({});
		vi.stubGlobal("fetch", fetcher);

		startPage(document);

		expect(getConfig()).toEqual(INSTANCE);
		expect(getLocale()).toBe("fr");
		expect(getMode()).toBe("dark");
		expect(document.documentElement.lang).toBe("fr");
		expect(document.documentElement.dataset["mode"]).toBe("dark");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("under vite dev, applies the visitor's choices at once without it, then the instance's limits", async () => {
		setCookie("secret_lang", "es");
		setCookie("secret_theme", "light");
		let answer: (response: Response) => void = () => undefined;
		const fetcher = vi.fn<typeof fetch>(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetcher);

		startPage(document);

		// Rendered from these, before the API has answered.
		expect(getConfig()).toEqual(DEFAULT_CONFIG);
		expect(getLocale()).toBe("es");
		expect(getMode()).toBe("light");
		expect(document.documentElement.lang).toBe("es");
		expect(document.documentElement.dataset["mode"]).toBe("light");
		expect(fetcher).toHaveBeenCalledWith("/api/v1/config");

		answer(Response.json({ maxExpiry: 3600 }));
		await vi.waitFor(() => expect(getConfig()).toEqual({ ...DEFAULT_CONFIG, maxExpiry: 3600 }));
	});

	it("in a build, starts a page without it from the defaults, and asks nothing", () => {
		// The server fills in every page of a build: this one is not its.
		vi.stubEnv("DEV", false);
		setCookie("secret_lang", "es");
		setCookie("secret_theme", "dark");
		setLocale("de");
		const fetcher = answering({ maxExpiry: 3600 });
		vi.stubGlobal("fetch", fetcher);

		startPage(document);

		expect(getConfig()).toEqual(DEFAULT_CONFIG);
		expect(getLocale()).toBe("en");
		expect(document.documentElement.dataset["mode"]).toBe("system");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("reads the page it is running in by default", () => {
		serve(serializeShellData({ config: INSTANCE, locale: "it", theme: "system" }));
		startPage();
		expect(getLocale()).toBe("it");
	});
});
