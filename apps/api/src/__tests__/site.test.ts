import { createHash } from "node:crypto";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { SHELL_HEAD_MARKER, SHELL_HTML_TAG } from "@largerio/secret-shared/site";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, type LogLevel } from "../logger.js";
import { compressedCopies, type EncodedBody, negotiate } from "../site/encodings.js";
import { cacheControlOf, contentTypeOf, isEmbeddable } from "../site/files.js";
import { loadBuiltSite, loadSite, SiteError } from "../site/load.js";
import { inlineScriptHashes } from "../site/scripts.js";
import { BOOT_SCRIPT, createSiteFixture, SHELL, type SiteFixture } from "./siteFixture.js";

let created: SiteFixture | undefined;

/** A fixture removed after the test. */
function useFixture(options?: Parameters<typeof createSiteFixture>[0]): SiteFixture {
	created = createSiteFixture(options);
	return created;
}

afterEach(() => {
	created?.remove();
	created = undefined;
	vi.restoreAllMocks();
});

function capture() {
	const lines: Array<{ level: LogLevel; entry: Record<string, unknown> }> = [];
	const logger = createLogger({
		write: (level, line) => lines.push({ level, entry: JSON.parse(line) }),
	});
	return { lines, logger };
}

function hashOf(script: string): string {
	return `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
}

describe("loadSite", () => {
	it("serves every file of the build but the shell, from memory", () => {
		const fixture = useFixture();
		const site = loadSite({ ...fixture, logger: capture().logger });

		expect([...site.files.keys()].sort()).toEqual([
			"/_app/immutable/assets/app.Cs3.css",
			"/_app/immutable/assets/inter.Dx4.woff2",
			"/_app/immutable/entry/app.Cd2.js",
			"/_app/immutable/entry/start.Bx1.js",
			"/_app/version.json",
			"/bundle.json",
			"/favicon.svg",
			"/og.png",
			"/wasm/cap_wasm_bg.wasm",
		]);
		expect(site.shell).toBe(SHELL);

		const favicon = site.files.get("/favicon.svg");
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
		expect(Buffer.from(favicon?.body ?? []).toString()).toBe(svg);
		expect(favicon?.etag).toBe(`"${createHash("sha256").update(svg).digest("hex")}"`);
		expect(favicon?.contentType).toBe("image/svg+xml");
		expect(favicon?.cacheControl).toBe("public, max-age=3600");
	});

	it("computes the digest of what it serves, as sha256sum would, bundle.json aside", () => {
		const fixture = useFixture();
		const { lines, logger } = capture();

		expect(loadSite({ ...fixture, logger }).digest).toBe(fixture.digest);
		expect(lines).toEqual([]);
	});

	it("needs no bundle.json, and computes the same digest without it", () => {
		const fixture = useFixture({ manifest: false });
		const { lines, logger } = capture();

		const site = loadSite({ ...fixture, logger });

		expect(site.digest).toBe(fixture.digest);
		expect(site.files.has("/bundle.json")).toBe(false);
		expect(lines).toEqual([]);
	});

	it("warns of a build changed after bundle.json was written, and names what it serves", () => {
		const fixture = useFixture();
		const built = fixture.digest;
		fixture.write("_app/immutable/entry/start.Bx1.js", "alert(1);\n");
		const { lines, logger } = capture();

		const site = loadSite({ ...fixture, logger });

		expect(site.digest).not.toBe(built);
		expect(lines).toEqual([
			{
				level: "warn",
				entry: expect.objectContaining({
					msg: "the web app was modified after its build: serving it as it is",
					built,
					served: site.digest,
				}),
			},
		]);
	});

	it.each(["not json", "[]", '{"digest":1}'])("warns of a bundle.json that is %s", (manifest) => {
		const fixture = useFixture();
		fixture.write("bundle.json", manifest);
		const { lines, logger } = capture();

		loadSite({ ...fixture, logger });

		expect(lines).toEqual([
			{ level: "warn", entry: expect.objectContaining({ built: null, served: fixture.digest }) },
		]);
	});

	it("warns on the process logger by default", () => {
		const fixture = useFixture();
		fixture.write("favicon.svg", "<svg/>");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		loadSite(fixture);

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"the web app was modified after its build'),
		);
	});

	it("leaves symbolic links out, as find -type f does", () => {
		const fixture = useFixture();
		symlinkSync(join(fixture.buildDir, "og.png"), join(fixture.buildDir, "link.png"));

		const site = loadSite({ ...fixture, logger: capture().logger });

		expect(site.files.has("/link.png")).toBe(false);
		expect(site.digest).toBe(fixture.digest);
	});

	it("compresses once what is worth it, each copy with its ETag, out of the digest", () => {
		const fixture = useFixture();
		const site = loadSite({ ...fixture, logger: capture().logger });
		const app = site.files.get("/_app/immutable/entry/app.Cd2.js");
		const etag = (app?.etag ?? "").slice(0, -1);

		expect(app?.encodings.map(({ encoding, etag }) => ({ encoding, etag }))).toEqual([
			{ encoding: "br", etag: `${etag}-br"` },
			{ encoding: "gzip", etag: `${etag}-gzip"` },
		]);
		expect(site.files.get("/og.png")?.encodings).toEqual([]);
		expect(site.files.get("/_app/immutable/assets/inter.Dx4.woff2")?.encodings).toEqual([]);
		expect(site.digest).toBe(fixture.digest);
	});

	it("hashes the shell's inline scripts for its CSP", () => {
		const fixture = useFixture();

		expect(loadSite({ ...fixture, logger: capture().logger }).scriptHashes).toEqual([
			hashOf(BOOT_SCRIPT),
		]);
	});

	it("reads every language's messages", () => {
		const fixture = useFixture();
		const { messages } = loadSite({ ...fixture, logger: capture().logger });

		expect(messages.en["view_title"]).toBe("Encrypted note");
		expect(messages.fr["view_title"]).toBe("Note chiffrée");
		expect(messages.ko).toEqual({});
	});

	it("keeps only the messages that are text", () => {
		const fixture = useFixture();
		fixture.write("messages/de.json", JSON.stringify({ view_title: "Notiz", count: 3, x: null }));

		expect(loadSite({ ...fixture, logger: capture().logger }).messages.de).toEqual({
			view_title: "Notiz",
		});
	});

	it("refuses a build without its shell", () => {
		const fixture = useFixture();
		const buildDir = join(fixture.buildDir, "_app");

		expect(() => loadSite({ ...fixture, buildDir, logger: capture().logger })).toThrow(
			new SiteError(`${join(buildDir, "index.html")} is missing`),
		);
	});

	it.each([
		[SHELL_HTML_TAG, SHELL.replace(SHELL_HTML_TAG, "<html>")],
		[SHELL_HEAD_MARKER, SHELL.replace(SHELL_HEAD_MARKER, "")],
	])("refuses a shell that lacks %s", (marker, shell) => {
		const fixture = useFixture({ shell });
		const path = join(fixture.buildDir, "index.html");

		let error: unknown;
		try {
			loadSite({ ...fixture, logger: capture().logger });
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(SiteError);
		expect((error as SiteError).name).toBe("SiteError");
		expect((error as SiteError).message).toBe(`${path} lacks ${marker}`);
		expect((error as SiteError).hint).toContain("pnpm build");
	});

	it.each([
		["{", "cannot be read"],
		["null", "is not a catalog of messages"],
		['["a"]', "is not a catalog of messages"],
		['"text"', "is not a catalog of messages"],
	])("refuses a language whose messages are %s", (content, reason) => {
		const fixture = useFixture();
		fixture.write("messages/ja.json", content);

		const load = () => loadSite({ ...fixture, logger: capture().logger });

		expect(load).toThrow(SiteError);
		expect(load).toThrow(`${join(fixture.messagesDir, "ja.json")} ${reason}`);
	});

	it("refuses a language whose messages are missing", () => {
		const fixture = useFixture();
		const messagesDir = join(fixture.messagesDir, "none");

		expect(() => loadSite({ ...fixture, messagesDir, logger: capture().logger })).toThrow(
			`${join(messagesDir, "en.json")} cannot be read: ENOENT`,
		);
	});
});

describe("loadBuiltSite", () => {
	it("loads the build when it has its shell", () => {
		const fixture = useFixture();

		const site = loadBuiltSite({ ...fixture, production: true, logger: capture().logger });

		expect(site?.digest).toBe(fixture.digest);
	});

	it("serves the API alone without a build, and says so in production only", () => {
		const fixture = useFixture();
		const missing = { ...fixture, buildDir: join(fixture.buildDir, "none") };
		const { lines, logger } = capture();

		expect(loadBuiltSite({ ...missing, production: false, logger })).toBeUndefined();
		expect(lines).toEqual([]);

		expect(loadBuiltSite({ ...missing, production: true, logger })).toBeUndefined();
		expect(lines).toEqual([
			{
				level: "warn",
				entry: expect.objectContaining({
					msg: "the web app is not built: serving the API alone",
					buildDir: missing.buildDir,
				}),
			},
		]);
	});

	it("warns on the process logger by default", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		loadBuiltSite({ buildDir: "/nowhere", messagesDir: "/nowhere", production: true });

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('"msg":"the web app is not built: serving the API alone"'),
		);
	});
});

describe("inlineScriptHashes", () => {
	it("hashes the scripts a browser runs, whatever the quotes around their type", () => {
		const html = [
			"<script>a()</script>",
			'<script type="module">b()</script>',
			"<script type='text/javascript'>c()</script>",
			"<script type=TEXT/JAVASCRIPT>d()</script>",
			'<script type="">e()</script>',
			"<SCRIPT async>f()</SCRIPT >",
		].join("\n");

		expect(inlineScriptHashes(html)).toEqual(
			["a()", "b()", "c()", "d()", "e()", "f()"].map(hashOf),
		);
	});

	it("leaves out the files and the data blocks, which need no hash", () => {
		const html = [
			'<script src="/_app/immutable/x.js"></script>',
			'<script type="module" src=/y.js></script>',
			'<script type="application/json" id="secret-shell">{"a":1}</script>',
			'<script type="application/ld+json">{"@type":"WebApplication"}</script>',
			'<script type="text/template"><p></p></script>',
		].join("\n");

		expect(inlineScriptHashes(html)).toEqual([]);
	});

	it("hashes a script once, however often it appears", () => {
		expect(inlineScriptHashes("<script>a()</script><script>a()</script>")).toEqual([hashOf("a()")]);
	});
});

describe("compressedCopies", () => {
	const text = Buffer.from(`export const app = "${"x".repeat(4096)}";\n`);

	it("compresses text and WebAssembly with brotli, then gzip", () => {
		for (const type of ["text/javascript; charset=utf-8", "application/wasm", "image/svg+xml"]) {
			const [br, gzip, ...rest] = compressedCopies(text, type);

			expect(br?.encoding).toBe("br");
			expect(brotliDecompressSync(br?.body ?? new Uint8Array())).toEqual(text);
			expect(gzip?.encoding).toBe("gzip");
			expect(gunzipSync(gzip?.body ?? new Uint8Array())).toEqual(text);
			expect(rest).toEqual([]);
		}
	});

	it("leaves alone what comes compressed, and what would not shrink", () => {
		expect(compressedCopies(text, "image/png")).toEqual([]);
		expect(compressedCopies(text, "font/woff2")).toEqual([]);
		expect(compressedCopies(text, "application/octet-stream")).toEqual([]);
		expect(compressedCopies(Buffer.from("a"), "text/plain; charset=utf-8")).toEqual([]);
	});
});

describe("negotiate", () => {
	const br: EncodedBody = { encoding: "br", body: new Uint8Array() };
	const gzip: EncodedBody = { encoding: "gzip", body: new Uint8Array() };
	const both = [br, gzip];

	it.each([
		["gzip, deflate, br, zstd", br],
		["GZIP, BR", br],
		["gzip", gzip],
		["gzip;q=0.5, br;q=0.1", br],
		["br;q=0, gzip", gzip],
		["br ; q=0 , gzip ; q=0.8", gzip],
		["br;q=no, gzip", gzip],
		["*", br],
		["*;q=0, gzip", gzip],
		["*;q=0", undefined],
		["deflate", undefined],
		["identity", undefined],
		["", undefined],
	])("picks for %o %o", (acceptEncoding, copy) => {
		expect(negotiate(acceptEncoding, both)).toBe(copy);
	});

	it("sends the body itself without Accept-Encoding, or without copies", () => {
		expect(negotiate(undefined, both)).toBeUndefined();
		expect(negotiate("gzip, br", [])).toBeUndefined();
	});
});

describe("contentTypeOf", () => {
	it.each([
		["_app/immutable/entry/start.js", "text/javascript; charset=utf-8"],
		["worker.mjs", "text/javascript; charset=utf-8"],
		["app.CSS", "text/css; charset=utf-8"],
		["_app/version.json", "application/json"],
		["favicon.svg", "image/svg+xml"],
		["og.png", "image/png"],
		["inter.woff2", "font/woff2"],
		["inter.woff", "font/woff"],
		["wasm/cap_wasm_bg.wasm", "application/wasm"],
		["200.html", "text/html; charset=utf-8"],
		["licenses.txt", "text/plain; charset=utf-8"],
		["archive.tar.gz", "application/octet-stream"],
		["LICENSE", "application/octet-stream"],
	])("serves %s as %s", (path, type) => {
		expect(contentTypeOf(path)).toBe(type);
	});
});

describe("isEmbeddable", () => {
	it.each([
		["og.png", "image/png", true],
		["favicon.svg", "image/svg+xml", true],
		["_app/immutable/assets/logo.Ab1.png", "image/png", false],
		["bundle.json", "application/json", false],
		["wasm/cap_wasm_bg.wasm", "application/wasm", false],
	])("lets other sites show %s (%s): %s", (path, type, embeddable) => {
		expect(isEmbeddable(path, type)).toBe(embeddable);
	});

	it("marks the files loadSite reads", () => {
		const fixture = useFixture();
		const site = loadSite({ ...fixture, logger: capture().logger });

		expect([...site.files].filter(([, file]) => file.embeddable).map(([path]) => path)).toEqual(
			expect.arrayContaining(["/og.png", "/favicon.svg"]),
		);
		expect([...site.files].filter(([, file]) => file.embeddable)).toHaveLength(2);
	});
});

describe("cacheControlOf", () => {
	it.each([
		["_app/immutable/entry/start.Bx1.js", "public, max-age=31536000, immutable"],
		["_app/version.json", "no-cache"],
		["bundle.json", "no-cache"],
		["favicon.svg", "public, max-age=3600"],
		["wasm/cap_wasm_bg.wasm", "public, max-age=3600"],
	])("caches %s with %s", (path, cacheControl) => {
		expect(cacheControlOf(path)).toBe(cacheControl);
	});
});
