export type ThemeMode = "dark" | "light";

const COOKIE_NAME = "secret_theme";
const MAX_AGE = 60 * 60 * 24 * 365;

let mode = $state<ThemeMode>("dark");

export function initTheme(initial?: ThemeMode): void {
	if (initial === "light" || initial === "dark") {
		mode = initial;
		return;
	}
	if (typeof document !== "undefined") {
		const current = document.documentElement.dataset.mode;
		mode = current === "light" ? "light" : "dark";
	}
}

export function getMode(): ThemeMode {
	return mode;
}

export function setMode(next: ThemeMode): void {
	mode = next;
	if (typeof document !== "undefined") {
		document.documentElement.dataset.mode = next;
		document.cookie = `${COOKIE_NAME}=${next}; path=/; max-age=${MAX_AGE}; samesite=lax`;
	}
}

export function toggleMode(): void {
	setMode(mode === "dark" ? "light" : "dark");
}
