export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "secret_theme";

let mode = $state<ThemeMode>("dark");

export function initTheme(): void {
	if (typeof document === "undefined") return;
	const current = document.documentElement.dataset.mode;
	mode = current === "light" ? "light" : "dark";
	document.body.dataset.mode = mode;
}

export function getMode(): ThemeMode {
	return mode;
}

export function setMode(next: ThemeMode): void {
	mode = next;
	if (typeof document !== "undefined") {
		document.documentElement.dataset.mode = next;
		document.body.dataset.mode = next;
	}
	if (typeof localStorage !== "undefined") {
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			/* ignore */
		}
	}
}

export function toggleMode(): void {
	setMode(mode === "dark" ? "light" : "dark");
}
