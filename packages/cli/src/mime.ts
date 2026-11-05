import { extname } from "node:path";

/**
 * The MIME types of the files people send most, by extension. The reader
 * shows a file by its type, so a type it cannot trust is worse than none:
 * anything else goes as `application/octet-stream`.
 */
const TYPES: ReadonlyMap<string, string> = new Map([
	// Text
	["txt", "text/plain"],
	["log", "text/plain"],
	["md", "text/markdown"],
	["csv", "text/csv"],
	["tsv", "text/tab-separated-values"],
	["html", "text/html"],
	["htm", "text/html"],
	["css", "text/css"],
	["ics", "text/calendar"],
	["vcf", "text/vcard"],
	["js", "text/javascript"],
	["mjs", "text/javascript"],
	["json", "application/json"],
	["xml", "application/xml"],
	["yaml", "application/yaml"],
	["yml", "application/yaml"],
	["toml", "application/toml"],
	["sql", "application/sql"],
	["sh", "application/x-sh"],
	// Documents
	["pdf", "application/pdf"],
	["rtf", "application/rtf"],
	["epub", "application/epub+zip"],
	["doc", "application/msword"],
	["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	["xls", "application/vnd.ms-excel"],
	["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	["ppt", "application/vnd.ms-powerpoint"],
	["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
	["odt", "application/vnd.oasis.opendocument.text"],
	["ods", "application/vnd.oasis.opendocument.spreadsheet"],
	["odp", "application/vnd.oasis.opendocument.presentation"],
	["eml", "message/rfc822"],
	// Images
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["gif", "image/gif"],
	["webp", "image/webp"],
	["avif", "image/avif"],
	["heic", "image/heic"],
	["bmp", "image/bmp"],
	["tif", "image/tiff"],
	["tiff", "image/tiff"],
	["ico", "image/vnd.microsoft.icon"],
	["svg", "image/svg+xml"],
	// Audio and video
	["mp3", "audio/mpeg"],
	["m4a", "audio/mp4"],
	["wav", "audio/wav"],
	["ogg", "audio/ogg"],
	["flac", "audio/flac"],
	["mp4", "video/mp4"],
	["mov", "video/quicktime"],
	["webm", "video/webm"],
	["mkv", "video/x-matroska"],
	// Archives
	["zip", "application/zip"],
	["gz", "application/gzip"],
	["tgz", "application/gzip"],
	["tar", "application/x-tar"],
	["bz2", "application/x-bzip2"],
	["xz", "application/x-xz"],
	["zst", "application/zstd"],
	["7z", "application/x-7z-compressed"],
	["rar", "application/vnd.rar"],
	// Keys and certificates
	["pem", "application/x-pem-file"],
	["crt", "application/x-x509-ca-cert"],
	["cer", "application/pkix-cert"],
	["p12", "application/x-pkcs12"],
	["pfx", "application/x-pkcs12"],
	["asc", "application/pgp-keys"],
	["gpg", "application/pgp-encrypted"],
	["kdbx", "application/x-keepass2"],
]);

export const DEFAULT_TYPE = "application/octet-stream";

/** The MIME type of a file, from its name's extension. */
export function mimeTypeOf(name: string): string {
	return TYPES.get(extname(name).slice(1).toLowerCase()) ?? DEFAULT_TYPE;
}
