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

	it("resolves the system preference from the OS setting", async () => {
		stubSystemTheme(true);
		const { getMode, initTheme } = await loadTheme();
		initTheme("system");
		expect(getMode()).toBe("dark");
	});

	it("falls back to light when the OS setting is unavailable (server, old browsers)", async () => {
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

	it("reads the preference the server rendered when none is passed", async () => {
		stubSystemTheme(true);
		const { getMode, initTheme } = await loadTheme();

		document.documentElement.dataset["mode"] = "light";
		initTheme();
		expect(getMode()).toBe("light");

		document.documentElement.dataset["mode"] = "system";
		initTheme();
		expect(getMode()).toBe("dark");
	});

	it("skips DOM side effects when document is undefined (SSR)", async () => {
		const { getMode, initTheme, setMode } = await loadTheme();
		setMode("dark");
		vi.stubGlobal("document", undefined);
		expect(() => setMode("light")).not.toThrow();
		expect(getMode()).toBe("light");

		initTheme();
		expect(getMode()).toBe("light");
	});
});
