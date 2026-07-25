/**
 * Copy via the legacy `document.execCommand("copy")` path.
 *
 * `navigator.clipboard` is undefined outside a secure context, which is exactly
 * the situation of a self-hosted instance reached over plain HTTP on a LAN or a
 * bare IP. Without this fallback the share link — the one thing the user must
 * not lose — cannot be copied at all.
 */
function copyViaExecCommand(text: string): boolean {
	if (typeof document === "undefined") return false;

	const textarea = document.createElement("textarea");
	textarea.value = text;
	// Keep it off-screen and non-focusable-looking, but still selectable.
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.top = "-9999px";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);

	try {
		textarea.select();
		textarea.setSelectionRange(0, text.length);
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		document.body.removeChild(textarea);
	}
}

/**
 * Copy text to the clipboard and report a transient "copied" state.
 *
 * Calls `setCopied(true)` on success, then `setCopied(false)` after `resetMs`.
 * Returns false only when both the Clipboard API and the legacy path fail, so
 * callers can surface an error message.
 */
export async function copyWithFeedback(
	text: string,
	setCopied: (copied: boolean) => void,
	resetMs = 2000,
): Promise<boolean> {
	let ok = false;

	try {
		await navigator.clipboard.writeText(text);
		ok = true;
	} catch {
		ok = copyViaExecCommand(text);
	}

	if (!ok) return false;

	setCopied(true);
	setTimeout(() => {
		setCopied(false);
	}, resetMs);
	return true;
}
