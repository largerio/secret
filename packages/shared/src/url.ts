/**
 * The URL without its trailing slashes. A loop rather than `/\/+$/`, which
 * backtracks quadratically on a long run of slashes followed by anything else.
 */
export function withoutTrailingSlashes(url: string): string {
	let end = url.length;
	while (end > 0 && url[end - 1] === "/") end--;
	return url.slice(0, end);
}
