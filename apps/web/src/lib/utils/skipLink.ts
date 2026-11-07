/**
 * Follows a skip link without its `#target` ever reaching the address: on a
 * note's page the fragment is the key, and the page took `main-content` for
 * one. The target takes the focus instead (it needs a `tabindex` of -1), and
 * the browser brings it into view as it would for the anchor.
 */
export function skipTo(event: Event, target: HTMLElement | undefined): void {
	event.preventDefault();
	target?.focus();
}
