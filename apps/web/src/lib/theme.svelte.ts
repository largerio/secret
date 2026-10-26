import { setPreferenceCookie } from "./utils/cookies.js";

/** The theme on screen. */
export type ThemeMode = "dark" | "light";
/** What the visitor chose: "system" until they pick a theme themselves. */
export type ThemePreference = ThemeMode | "system";

const COOKIE_NAME = "secret_theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

let mode = $state<ThemeMode>("light");
let followsSystem = true;
let listening = false;

function systemQuery(): MediaQueryList | undefined {
	if (typeof matchMedia !== "function") return undefined;
	return matchMedia(DARK_QUERY);
}

function documentPreference(): ThemePreference | undefined {
	if (typeof document === "undefined") return undefined;
	const current = document.documentElement.dataset["mode"];
	return current === "light" || current === "dark" ? current : "system";
}

// The page's colours follow the OS through CSS on their own; this keeps the
// toggle's icon and label in step when the OS switches while the page is open.
function listenToSystem(query: MediaQueryList): void {
	if (listening) return;
	listening = true;
	query.addEventListener("change", (event) => {
		if (followsSystem) mode = event.matches ? "dark" : "light";
	});
}

/** Sync the store with the preference the server rendered into `<html data-mode>`. */
export function initTheme(preference?: ThemePreference): void {
	const initial = preference ?? documentPreference();
	if (!initial) return;

	followsSystem = initial === "system";
	if (initial !== "system") {
		mode = initial;
		return;
	}

	const query = systemQuery();
	mode = query?.matches ? "dark" : "light";
	if (query) listenToSystem(query);
}

export function getMode(): ThemeMode {
	return mode;
}

export function setMode(next: ThemeMode): void {
	mode = next;
	followsSystem = false;
	if (typeof document !== "undefined") {
		document.documentElement.dataset["mode"] = next;
		setPreferenceCookie(COOKIE_NAME, next);
	}
}

export function toggleMode(): void {
	setMode(mode === "dark" ? "light" : "dark");
}
