import { beforeEach, describe, expect, it } from "vitest";
import { getMode, initTheme, setMode, toggleMode } from "../theme.svelte.js";

describe("theme store", () => {
	beforeEach(() => {
		delete document.documentElement.dataset["mode"];
	});

	it("defaults to dark mode", () => {
		expect(getMode()).toBe("dark");
	});

	it("setMode updates state, the document dataset, and the cookie", () => {
		setMode("light");
		expect(getMode()).toBe("light");
		expect(document.documentElement.dataset["mode"]).toBe("light");
		expect(document.cookie).toContain("secret_theme=light");
	});

	it("toggleMode flips between dark and light", () => {
		setMode("dark");
		toggleMode();
		expect(getMode()).toBe("light");
		toggleMode();
		expect(getMode()).toBe("dark");
	});

	it("initTheme honors an explicit initial value", () => {
		initTheme("light");
		expect(getMode()).toBe("light");
		initTheme("dark");
		expect(getMode()).toBe("dark");
	});

	it("initTheme falls back to the document dataset when no value is given", () => {
		document.documentElement.dataset["mode"] = "light";
		initTheme();
		expect(getMode()).toBe("light");

		document.documentElement.dataset["mode"] = "dark";
		initTheme();
		expect(getMode()).toBe("dark");
	});
});
