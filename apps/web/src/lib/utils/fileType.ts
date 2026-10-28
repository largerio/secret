export type FileCategory = "image" | "video" | "audio" | "other";

/** Categorize a MIME type for preview rendering. */
export function getFileCategory(mimeType: string): FileCategory {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("audio/")) return "audio";
	return "other";
}

/**
 * Whether the browser can render an inline preview for this MIME type. Not a
 * PDF: browsers draw one with a plugin, and plugins never run in the
 * sandboxed frame a file chosen by the sender would get.
 */
export function isPreviewable(mimeType: string): boolean {
	return getFileCategory(mimeType) !== "other";
}
