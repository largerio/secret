/**
 * Copy text to the clipboard and report a transient "copied" state.
 *
 * Calls `setCopied(true)` on success, then `setCopied(false)` after `resetMs`.
 * Returns false when the Clipboard API is unavailable or rejects, so callers
 * can surface an error message.
 */
export async function copyWithFeedback(
	text: string,
	setCopied: (copied: boolean) => void,
	resetMs = 2000,
): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		return false;
	}
	setCopied(true);
	setTimeout(() => {
		setCopied(false);
	}, resetMs);
	return true;
}
