import { createHash } from "node:crypto";

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * The types a browser runs a script of (HTML's JavaScript MIME type essences,
 * `module`, or none). Any other type is a data block, such as the shell data or
 * JSON-LD: never run, so it needs no hash.
 */
const EXECUTED_TYPES = new Set([
	"",
	"module",
	"application/ecmascript",
	"application/javascript",
	"application/x-ecmascript",
	"application/x-javascript",
	"text/ecmascript",
	"text/javascript",
	"text/javascript1.0",
	"text/javascript1.1",
	"text/javascript1.2",
	"text/javascript1.3",
	"text/javascript1.4",
	"text/javascript1.5",
	"text/jscript",
	"text/livescript",
	"text/x-ecmascript",
	"text/x-javascript",
]);

function attributesOf(tag: string): ReadonlyMap<string, string> {
	const attributes = new Map<string, string>();
	for (const [, name, ...values] of tag.matchAll(ATTRIBUTE)) {
		// The name always matches; the value is in one of three groups, or none for a bare attribute.
		attributes.set((name as string).toLowerCase(), values.find((v) => v !== undefined) ?? "");
	}
	return attributes;
}

function isInlineAndExecuted(attributes: ReadonlyMap<string, string>): boolean {
	if (attributes.has("src")) return false;
	return EXECUTED_TYPES.has((attributes.get("type") ?? "").trim().toLowerCase());
}

/**
 * The CSP sources (`'sha256-…'`) that let the shell's inline scripts run:
 * SvelteKit's boot script, which a static build cannot give a nonce. A script
 * with a `src` is a file of the build, allowed by `'self'`.
 */
export function inlineScriptHashes(html: string): ReadonlyArray<string> {
	const hashes = new Set<string>();
	for (const [, tag, content] of html.matchAll(SCRIPT)) {
		if (isInlineAndExecuted(attributesOf(tag as string))) {
			hashes.add(
				`'sha256-${createHash("sha256")
					.update(content as string)
					.digest("base64")}'`,
			);
		}
	}
	return [...hashes];
}
