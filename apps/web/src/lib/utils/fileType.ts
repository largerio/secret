export type FileCategory = "image" | "video" | "audio" | "pdf" | "other";

/** Categorize a MIME type for preview rendering. */
export function getFileCategory(mimeType: string): FileCategory {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType === "application/pdf") return "pdf";
	return "other";
}

/** Whether the browser can render an inline preview for this MIME type. */
export function isPreviewable(mimeType: string): boolean {
	return getFileCategory(mimeType) !== "other";
}
