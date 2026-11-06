import { afterEach, describe, expect, it, vi } from "vitest";
import { readCookie, setPreferenceCookie } from "../cookies.js";

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

describe("readCookie", () => {
	it("finds a cookie among others, wherever it stands", () => {
		const cookies = "a=1; secret_lang=fr;secret_theme=dark";
		expect(readCookie(cookies, "secret_lang")).toBe("fr");
		expect(readCookie(cookies, "secret_theme")).toBe("dark");
		expect(readCookie(cookies, "a")).toBe("1");
	});

	it("keeps an equals sign that belongs to the value", () => {
		expect(readCookie("token=a=b", "token")).toBe("a=b");
	});

	it("is undefined for a cookie not set, or only named alike", () => {
		expect(readCookie("", "secret_lang")).toBeUndefined();
		expect(readCookie("my_secret_lang=fr; secret_lang_old=de", "secret_lang")).toBeUndefined();
		expect(readCookie("secret_lang", "secret_lang")).toBeUndefined();
	});
});
