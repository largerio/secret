import { afterEach, describe, expect, it, vi } from "vitest";
import { setPreferenceCookie } from "../cookies.js";

describe("setPreferenceCookie", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("writes a samesite=lax cookie with a one-year default max-age", () => {
		const setCookie = vi.spyOn(Document.prototype, "cookie", "set");
		setPreferenceCookie("secret_theme", "light");
		expect(setCookie).toHaveBeenCalledWith(
			"secret_theme=light; path=/; max-age=31536000; samesite=lax",
		);
		expect(document.cookie).toContain("secret_theme=light");
	});

	it("honors an explicit max-age", () => {
		const setCookie = vi.spyOn(Document.prototype, "cookie", "set");
		setPreferenceCookie("secret_lang", "fr", 3600);
		expect(setCookie).toHaveBeenCalledWith("secret_lang=fr; path=/; max-age=3600; samesite=lax");
	});

	it("adds the Secure flag when served over HTTPS", () => {
		vi.stubGlobal("location", { protocol: "https:" });
		const setCookie = vi.spyOn(Document.prototype, "cookie", "set");
		setPreferenceCookie("secret_theme", "dark");
		expect(setCookie).toHaveBeenCalledWith(
			"secret_theme=dark; path=/; max-age=31536000; samesite=lax; secure",
		);
	});
});
