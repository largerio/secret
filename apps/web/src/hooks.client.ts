import type { ClientInit } from "@sveltejs/kit/hooks";
import { startPage } from "#lib/shell.js";

// Once, as the app starts and before the first page renders: the shell data
// applied. Not in a load, which an invalidateAll() would run again, putting
// the shell's language and theme back over the ones the visitor picked since.
export const init: ClientInit = () => {
	startPage();
};
