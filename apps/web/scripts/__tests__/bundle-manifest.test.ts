// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHELL_HEAD_MARKER, SHELL_HTML_TAG } from "@largerio/secret-shared/site";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleManifest, checkShell, writeBundleManifest } from "../bundle-manifest.ts";

const SHELL = `<!doctype html>\n${SHELL_HTML_TAG}<head>${SHELL_HEAD_MARKER}</head></html>\n`;

function sha256(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

let dir: string;

/** A bundle laid out as the build writes one, a stale manifest included. */
async function writeBundle(): Promise<void> {
	await mkdir(join(dir, "_app/immutable"), { recursive: true });
	await writeFile(join(dir, "index.html"), SHELL);
	await writeFile(join(dir, "_app/immutable/b.js"), "export {};\n");
	await writeFile(join(dir, "_app/version.json"), '{"version":"1"}');
	await writeFile(join(dir, "favicon.svg"), "<svg/>");
	await writeFile(join(dir, "bundle.json"), "stale");
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "secret-bundle-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("bundleManifest", () => {
	it("lists every file but itself, sorted, with its hash and size", async () => {
		await writeBundle();
		const manifest = await bundleManifest(dir);

		expect(manifest.version).toBe(1);
		expect(manifest.files).toEqual([
			{ path: "_app/immutable/b.js", sha256: sha256("export {};\n"), size: 11 },
			{ path: "_app/version.json", sha256: sha256('{"version":"1"}'), size: 15 },
			{ path: "favicon.svg", sha256: sha256("<svg/>"), size: 6 },
			{ path: "index.html", sha256: sha256(SHELL), size: Buffer.byteLength(SHELL) },
		]);
	});

	it("digests the listing sha256sum prints for the files", async () => {
		await writeBundle();
		const manifest = await bundleManifest(dir);

		// `find … | LC_ALL=C sort | xargs sha256sum | sha256sum`, as bundle.ts documents it.
		const listing = manifest.files.map((file) => `${file.sha256}  ${file.path}\n`).join("");
		expect(manifest.digest).toBe(`sha256:${sha256(listing)}`);
	});
});

describe("checkShell", () => {
	it("accepts a shell the server can fill in", () => {
		expect(() => checkShell(SHELL)).not.toThrow();
	});

	it("refuses one without either marker", () => {
		expect(() => checkShell(SHELL.replace(SHELL_HTML_TAG, "<html>"))).toThrow(SHELL_HTML_TAG);
		expect(() => checkShell(SHELL.replace(SHELL_HEAD_MARKER, ""))).toThrow(SHELL_HEAD_MARKER);
	});

	it("accepts assets named from the root, and refuses them named from the page", () => {
		const page = (asset: string) => SHELL.replace("</head>", `${asset}</head>`);
		expect(() =>
			checkShell(page('<link href="/_app/a.css"><script>import("/_app/b.js")')),
		).not.toThrow();
		for (const relative of [
			'<link href="./_app/a.css">',
			'<link rel="icon" href="../favicon.svg">',
			'<script src="./_app/b.js">',
			'<script>import("./_app/b.js")',
		]) {
			expect(() => checkShell(page(relative))).toThrow("served at every path");
		}
	});
});

describe("writeBundleManifest", () => {
	it("writes the manifest at the bundle's root", async () => {
		await writeBundle();
		const manifest = await writeBundleManifest(dir);
		const written: unknown = JSON.parse(await readFile(join(dir, "bundle.json"), "utf8"));

		expect(written).toEqual(manifest);
		// Written again, it is the same: the manifest never lists itself.
		await expect(writeBundleManifest(dir)).resolves.toEqual(manifest);
	});

	it("writes nothing for a shell the server could not fill in", async () => {
		await writeBundle();
		await writeFile(join(dir, "index.html"), "<html><head></head></html>");

		await expect(writeBundleManifest(dir)).rejects.toThrow("the server cannot fill it in");
		await expect(readFile(join(dir, "bundle.json"), "utf8")).resolves.toBe("stale");
	});
});
