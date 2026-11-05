/**
 * The path without its trailing slashes. A loop rather than `/\/+$/`, which
 * backtracks quadratically on a long run of slashes followed by anything else.
 */
export function withoutTrailingSlashes(path: string): string {
	let end = path.length;
	while (end > 0 && path[end - 1] === "/") {
		end--;
	}
	return path.slice(0, end);
}
