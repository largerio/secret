import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ChangeListener = (event: { matches: boolean }) => void;

/** A matchMedia stand-in whose OS theme the test can flip. */
function stubSystemTheme(dark: boolean) {
	const listeners: ChangeListener[] = [];
	const query = {
		matches: dark,
		addEventListener: vi.fn((_type: string, listener: ChangeListener) => listeners.push(listener)),
	};
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => query),
	);
	return {
		query,
		flip(next: boolean) {
			query.matches = next;
			for (const listener of listeners) listener({ matches: next });
		},
	};
}

// The store keeps module state (the system listener is registered once), so
// each test gets a fresh copy.
async function loadTheme() {
	vi.resetModules();
	return import("../theme.svelte.js");
}

describe("theme store", () => {
	beforeEach(() => {
		delete document.documentElement.dataset["mode"];
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("starts light until told otherwise", async () => {
		const { getMode } = await loadTheme();
		expect(getMode()).toBe("light");
	});

	it("setMode updates state, the document dataset, and the cookie", async () => {
		const { getMode, setMode } = await loadTheme();
		setMode("dark");
		expect(getMode()).toBe("dark");
		expect(document.documentElement.dataset["mode"]).toBe("dark");
		expect(document.cookie).toContain("secret_theme=dark");
	});

	it("toggleMode flips between dark and light", async () => {
		const { getMode, setMode, toggleMode } = await loadTheme();
		setMode("dark");
		toggleMode();
		expect(getMode()).toBe("light");
		toggleMode();
		expect(getMode()).toBe("dark");
	});

	it("initTheme honours an explicit theme", async () => {
		const { getMode, initTheme } = await loadTheme();
		initTheme("dark");
		expect(getMode()).toBe("dark");
		initTheme("light");
		expect(getMode()).toBe("light");
	});

	it("initTheme writes the preference on <html>, where the CSS reads it", async () => {
		stubSystemTheme(true);
		const { initTheme } = await loadTheme();
		initTheme("light");
		expect(document.documentElement.dataset["mode"]).toBe("light");
		initTheme("system");
		expect(document.documentElement.dataset["mode"]).toBe("system");
	});

	it("resolves the system preference from the OS setting", async () => {
		stubSystemTheme(true);
		const { getMode, initTheme } = await loadTheme();
		initTheme("system");
		expect(getMode()).toBe("dark");
	});

	it("falls back to light when the OS setting is unavailable (old browsers)", async () => {
		vi.stubGlobal("matchMedia", undefined);
		const { getMode, initTheme } = await loadTheme();
		initTheme("system");
		expect(getMode()).toBe("light");
	});

	it("follows the OS while no theme has been picked, then stops", async () => {
		const system = stubSystemTheme(false);
		const { getMode, initTheme, setMode } = await loadTheme();
		initTheme("system");
		initTheme("system");
		expect(system.query.addEventListener).toHaveBeenCalledTimes(1);

		system.flip(true);
		expect(getMode()).toBe("dark");
		system.flip(false);
		expect(getMode()).toBe("light");

		setMode("light");
		system.flip(true);
		expect(getMode()).toBe("light");
	});
});
