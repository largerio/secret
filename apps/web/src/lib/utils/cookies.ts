const YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Write a first-party preference cookie (theme, locale). Adds the Secure flag
 * when the page is served over HTTPS so the cookie is never sent in clear.
 */
export function setPreferenceCookie(
	name: string,
	value: string,
	maxAge: number = YEAR_SECONDS,
): void {
	const secure = location.protocol === "https:" ? "; secure" : "";
	// biome-ignore lint/suspicious/noDocumentCookie: CookieStore API not universally supported
	document.cookie = `${name}=${value}; path=/; max-age=${maxAge}; samesite=lax${secure}`;
}
