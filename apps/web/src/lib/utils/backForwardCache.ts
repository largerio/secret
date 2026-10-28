/**
 * Keeps what a page reveals out of the back-forward cache. A page left for
 * another site can be kept frozen as it stands, and Back then shows it again:
 * a note read once, the link that holds the only copy of its key. `forget`
 * runs as the page is put away, `restore` as it comes back. Returns the
 * function that stops listening.
 */
export function onBackForwardCache(forget: () => void, restore?: () => void): () => void {
	const hide = (event: PageTransitionEvent) => {
		if (event.persisted) forget();
	};
	const show = (event: PageTransitionEvent) => {
		if (event.persisted) restore?.();
	};
	window.addEventListener("pagehide", hide);
	window.addEventListener("pageshow", show);
	return () => {
		window.removeEventListener("pagehide", hide);
		window.removeEventListener("pageshow", show);
	};
}
