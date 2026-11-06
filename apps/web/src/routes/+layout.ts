import { startPage } from "#lib/shell.js";
import type { LayoutLoad } from "./$types";

// A single-page app: the server answers every page with the one shell the
// build writes (index.html), which it fills in, and the browser renders it.
export const ssr = false;
export const prerender = false;

export const load: LayoutLoad = () => {
	// Applies the shell data at once; without any, the page renders from the
	// defaults while the instance's limits are fetched.
	void startPage();
};
