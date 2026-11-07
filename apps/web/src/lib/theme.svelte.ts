import { THEME_COOKIE, type ThemePreference } from "@largerio/secret-shared/site";
import { setPreferenceCookie } from "./utils/cookies.js";

/** The theme on screen. */
export type ThemeMode = "dark" | "light";

const DARK_QUERY = "(prefers-color-scheme: dark)";

let mode = $state<ThemeMode>("light");
let followsSystem = true;
let listening = false;

function systemQuery(): MediaQueryList | undefined {
	if (typeof matchMedia !== "function") return undefined;
	return matchMedia(DARK_QUERY);
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

/** Sync the store with the preference the page started from. */
export function initTheme(preference: ThemePreference): void {
	followsSystem = preference === "system";
	if (preference !== "system") {
		mode = preference;
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
	document.documentElement.dataset["mode"] = next;
	setPreferenceCookie(THEME_COOKIE, next);
}

export function toggleMode(): void {
	setMode(mode === "dark" ? "light" : "dark");
}
