import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
// Extends Zod with `.openapi()` before `@largerio/secret-shared` builds its
// schemas, as the routes expect (the production entry point does the same).
import "@hono/zod-openapi";
import { SECRETSTREAM_ABYTES } from "@largerio/secret-crypto/client";
import {
	MAX_EXPIRY_SECONDS,
	MAX_FILES_PER_NOTE,
	MAX_MESSAGE_LENGTH,
} from "@largerio/secret-shared";
import { INSTANCE_LIMITS, pageTitle, parseShellData } from "@largerio/secret-shared/site";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AppEnv, createApp } from "../app.js";
import { parseConfig } from "../config.js";
import { type AppDatabase, createDatabase } from "../db/index.js";
import { createLogger } from "../logger.js";
import { accentStyle } from "../site/accent.js";
import { loadSite, type Site } from "../site/load.js";
import { LocalStorage } from "../storage/local.js";
import { problemOf } from "./problems.js";
import {
	BOOT_SCRIPT,
	createSiteFixture,
	FILES,
	MESSAGES,
	type SiteFixture,
} from "./siteFixture.js";
import { createTestApp } from "./testApp.js";

const TEST_DB_PATH = "./data/site-routes-test.db";
const TEST_FILES_PATH = "./data/site-routes-test-files";
const SERVER_KEY = randomBytes(32);
const METRICS_TOKEN = "m".repeat(32);
const NOTE_ID = "aBcDeFgHiJkL";
const APP_URL = "https://secret.test";

const SITE_CSP = [
	"default-src 'none'",
	`script-src 'self' 'wasm-unsafe-eval' 'sha256-${createHash("sha256").update(BOOT_SCRIPT).digest("base64")}'`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"connect-src 'self'",
	"font-src 'self'",
	"worker-src 'self' blob:",
	"media-src 'self' blob:",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'none'",
].join("; ");

const silent = createLogger({ write: () => {} });

let db: AppDatabase;
let sqlite: DatabaseSync;
let fixture: SiteFixture;
let site: Site;
const stops: Array<() => void> = [];

function removeFiles(): void {
	for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
		rmSync(path, { force: true });
	}
	rmSync(TEST_FILES_PATH, { recursive: true, force: true });
}

/** The app with the fixture's site, another one, or none (null). */
function makeApp(env: Record<string, string> = {}, served: Site | null = site): Hono<AppEnv> {
	const created = createTestApp({
		db,
		serverKey: SERVER_KEY,
		storage: new LocalStorage(TEST_FILES_PATH),
		env: { APP_URL, ...env },
		...(served ? { site: served } : {}),
	});
	stops.push(created.stop);
	return created.app;
}

/** The body as it was before its Content-Encoding. */
async function decodedBody(res: Response): Promise<Buffer> {
	const body = Buffer.from(await res.arrayBuffer());
	const encoding = res.headers.get("content-encoding");
	if (encoding === "br") return brotliDecompressSync(body);
	if (encoding === "gzip") return gunzipSync(body);
	return body;
}

/** The text of the shell's `<script id="secret-shell">`. */
function shellDataOf(html: string) {
	const text = /<script type="application\/json" id="secret-shell">([^<]*)<\/script>/.exec(html);
	return parseShellData(text?.[1]);
}

beforeAll(() => {
	fixture = createSiteFixture();
	site = loadSite({ ...fixture, logger: silent });
});

afterAll(() => {
	fixture.remove();
	removeFiles();
});

beforeEach(() => {
	removeFiles();
	mkdirSync(TEST_FILES_PATH, { recursive: true });
	({ db, sqlite } = createDatabase(TEST_DB_PATH));
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	sqlite.close();
});

describe("the pages", () => {
	it("render the home page with its head, for crawlers that run no JavaScript", async () => {
		const res = await makeApp().request("/");
		const html = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("cache-control")).toBe("no-cache");
		expect(res.headers.get("vary")).toContain("Accept-Language, Cookie");
		expect(html).toContain('<html lang="en" data-mode="system">');
		expect(html).not.toContain("<!--secret:head-->");
		for (const tag of [
			"<title>Secret — Encrypted sharing</title>",
			'<meta name="description" content="Share secrets: encrypted in your browser." />',
			'<meta name="keywords" content="encrypted notes, secret sharing" />',
			`<link rel="canonical" href="${APP_URL}" />`,
			'<meta property="og:title" content="Secret — Encrypted sharing" />',
			'<meta property="og:description" content="Share secrets: encrypted in your browser." />',
			`<meta property="og:url" content="${APP_URL}" />`,
			'<meta name="twitter:title" content="Secret — Encrypted sharing" />',
			'<meta name="twitter:description" content="Share secrets: encrypted in your browser." />',
			'<meta property="og:site_name" content="Secret" />',
			'<meta property="og:type" content="website" />',
			'<meta property="og:locale" content="en_US" />',
			'<meta property="og:locale:alternate" content="fr_FR" />',
			`<meta property="og:image" content="${APP_URL}/og.png" />`,
			`<meta name="twitter:image" content="${APP_URL}/og.png" />`,
			'<meta name="twitter:card" content="summary_large_image" />',
			`<link rel="alternate" hreflang="ko" href="${APP_URL}" />`,
			`<link rel="alternate" hreflang="x-default" href="${APP_URL}" />`,
		]) {
			expect(html).toContain(tag);
		}
		expect(html).not.toContain('<meta property="og:locale:alternate" content="en_US" />');
		expect(html).not.toContain('name="robots"');
		// The rest of the shell is left as the build wrote it.
		expect(html).toContain(`<script>${BOOT_SCRIPT}</script>`);
	});

	/** The home page's descriptions: its meta tags' and its JSON-LD's. */
	function descriptionsOf(html: string) {
		const content = (attribute: string) =>
			new RegExp(`<meta ${attribute} content="([^"]*)" />`).exec(html)?.[1];
		const jsonLd = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)?.[1];
		return [
			content('name="description"'),
			content('property="og:description"'),
			content('name="twitter:description"'),
			JSON.parse(jsonLd ?? "{}").description,
		];
	}

	it("describe the home page in each language, without APP_DESCRIPTION", async () => {
		const app = makeApp();
		const home = async (language: string) =>
			(await app.request("/", { headers: { "Accept-Language": language } })).text();

		expect(descriptionsOf(await home("en"))).toEqual(
			Array(4).fill("Share secrets: encrypted in your browser."),
		);
		expect(descriptionsOf(await home("fr"))).toEqual(
			Array(4).fill("Partagez des secrets : chiffrés dans votre navigateur."),
		);
	});

	it("describe the home page by APP_DESCRIPTION in every language, once it is set", async () => {
		const app = makeApp({ APP_DESCRIPTION: `Our "notes" & <files>` });

		for (const language of ["en", "fr", "ko"]) {
			const res = await app.request("/", { headers: { "Accept-Language": language } });
			const [meta, og, twitter, jsonLd] = descriptionsOf(await res.text());

			expect([meta, og, twitter]).toEqual(
				Array(3).fill("Our &quot;notes&quot; &amp; &lt;files&gt;"),
			);
			expect(jsonLd).toBe(`Our "notes" & <files>`);
		}
	});

	it("keep a note's own description, APP_DESCRIPTION or not", async () => {
		const res = await makeApp({ APP_DESCRIPTION: "Our notes" }).request(`/note/${NOTE_ID}`);
		const html = await res.text();

		expect(html).toContain(
			'<meta name="description" content="Decrypted in your browser, never on the server." />',
		);
		expect(html).not.toContain("Our notes");
	});

	it("describe the instance in JSON-LD", async () => {
		const html = await (await makeApp().request("/")).text();
		const jsonLd = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)?.[1];

		expect(JSON.parse(jsonLd ?? "")).toEqual({
			"@context": "https://schema.org",
			"@type": "WebApplication",
			name: "Secret",
			url: APP_URL,
			description: "Share secrets: encrypted in your browser.",
			applicationCategory: "SecurityApplication",
			operatingSystem: "Any",
			offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
			featureList: [
				"End-to-end encryption",
				"Zero-knowledge architecture",
				"Burn after reading",
				"Password protection",
				"File sharing",
				"QR code sharing",
				"Self-hostable",
			],
		});
	});

	it("hand the page the instance's settings and the visitor's choices", async () => {
		const app = makeApp({
			APP_NAME: "Vault",
			APP_DESCRIPTION: "Our notes",
			APP_FOOTER_TEXT: "Run by ACME",
			MAX_FILE_SIZE: "1048576",
			MAX_FILES_PER_NOTE: "3",
			MAX_EXPIRY: "3600",
		});

		const html = await (await app.request("/")).text();

		expect(shellDataOf(html)).toEqual({
			config: {
				appName: "Vault",
				footerText: "Run by ACME",
				maxFileSize: 1_048_576,
				maxFilesPerNote: 3,
				chunkSize: 4_194_304,
				maxChunkedFileSize: 524_288_000,
				maxExpiry: 3600,
			},
			locale: "en",
			theme: "system",
		});
	});

	it("hand the page the limits GET /api/v1/config answers, and the API no more", async () => {
		const app = makeApp({ MAX_FILE_SIZE: "1048576", MAX_EXPIRY: "3600" });

		const config = shellDataOf(await (await app.request("/")).text())?.config;
		const answered = await (await app.request("/api/v1/config")).json();

		expect(Object.keys(answered).sort()).toEqual([...INSTANCE_LIMITS].sort());
		expect(config).toMatchObject(answered);
	});

	it("hand the page every limit the instance takes, the largest ones included", async () => {
		const largest = {
			MAX_FILE_SIZE: String(Number.MAX_SAFE_INTEGER),
			MAX_FILES_PER_NOTE: String(MAX_FILES_PER_NOTE),
			CHUNK_SIZE: String(MAX_MESSAGE_LENGTH - SECRETSTREAM_ABYTES),
			MAX_CHUNKED_FILE_SIZE: String(Number.MAX_SAFE_INTEGER),
			MAX_EXPIRY: String(MAX_EXPIRY_SECONDS),
		};

		const data = shellDataOf(await (await makeApp(largest).request("/")).text());

		expect(data?.config).toMatchObject({
			maxFileSize: Number.MAX_SAFE_INTEGER,
			maxFilesPerNote: MAX_FILES_PER_NOTE,
			chunkSize: MAX_MESSAGE_LENGTH - SECRETSTREAM_ABYTES,
			maxChunkedFileSize: Number.MAX_SAFE_INTEGER,
			maxExpiry: MAX_EXPIRY_SECONDS,
		});
	});

	it("speak the browser's language, English filling what a translation lacks", async () => {
		const res = await makeApp().request("/", { headers: { "Accept-Language": "fr-FR,fr;q=0.9" } });
		const html = await res.text();

		expect(html).toContain('<html lang="fr" data-mode="system">');
		expect(html).toContain("<title>Secret — Partage chiffré</title>");
		expect(html).toContain('<meta name="keywords" content="encrypted notes, secret sharing" />');
		expect(html).toContain('<meta property="og:locale" content="fr_FR" />');
		expect(html).toContain('<meta property="og:locale:alternate" content="en_US" />');
		expect(html).not.toContain('<meta property="og:locale:alternate" content="fr_FR" />');
		expect(shellDataOf(html)?.locale).toBe("fr");
	});

	it("speak the language the visitor chose over their browser's", async () => {
		const app = makeApp();
		const request = (cookie: string) =>
			app.request("/note/x", { headers: { Cookie: cookie, "Accept-Language": "fr" } });

		const chosen = await (await request("secret_lang=de")).text();
		expect(chosen).toContain('<html lang="de"');
		expect(chosen).toContain("<title>Secret — Encrypted note</title>");

		const unknown = await (await request("secret_lang=xx")).text();
		expect(unknown).toContain('<html lang="fr"');
	});

	it("keep the theme the visitor chose, the system's otherwise", async () => {
		const app = makeApp();
		const themeOf = async (cookie: string) =>
			shellDataOf(await (await app.request("/", { headers: { Cookie: cookie } })).text())?.theme;

		expect(await themeOf("secret_theme=dark")).toBe("dark");
		expect(await themeOf("secret_theme=light; secret_lang=en")).toBe("light");
		expect(await themeOf("secret_theme=sepia")).toBe("system");

		const html = await (
			await app.request("/", { headers: { Cookie: "secret_theme=dark" } })
		).text();
		expect(html).toContain('<html lang="en" data-mode="dark">');
	});

	it("carry the instance's accent on <html>", async () => {
		const html = await (await makeApp({ APP_PRIMARY_COLOR: "#0a7" }).request("/")).text();

		expect(html).toContain(
			`<html lang="en" data-mode="system" style="${accentStyle("#0a7") as string}">`,
		);
	});

	it("ignore an accent that is not a hex colour", async () => {
		const html = await (
			await makeApp({ APP_PRIMARY_COLOR: 'red" onload="alert(1)' }).request("/")
		).text();

		expect(html).toContain('<html lang="en" data-mode="system">');
		expect(html).not.toContain(' onload="');
	});

	it("escape every setting written into the page", async () => {
		const name = `</title><script>alert("x")</script> & $& 'q'`;
		const app = makeApp({ APP_NAME: name, APP_OG_IMAGE_URL: 'https://x.test/"><b>' });

		const html = await (await app.request("/")).text();

		expect(html).not.toContain("<script>alert");
		expect(html).not.toContain("<b>");
		expect(html).toContain(
			"<title>&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; $&amp; &#39;q&#39; — Encrypted sharing</title>",
		);
		expect(html).toContain('content="https://x.test/&quot;&gt;&lt;b&gt;"');
		expect(html).toContain('"name":"\\u003c/title\\u003e\\u003cscript\\u003ealert(\\"x\\")');
		expect(shellDataOf(html)?.config.appName).toBe(name);
	});

	it("render a note's page without indexing it", async () => {
		const res = await makeApp().request(`/note/${NOTE_ID}`);
		const html = await res.text();

		expect(res.status).toBe(200);
		for (const tag of [
			"<title>Secret — Encrypted note</title>",
			'<meta name="robots" content="noindex, nofollow" />',
			'<meta name="description" content="Decrypted in your browser, never on the server." />',
			'<meta property="og:title" content="Secret — Encrypted note" />',
			'<meta property="og:description" content="Decrypted in your browser, never on the server." />',
			'<meta property="og:site_name" content="Secret" />',
		]) {
			expect(html).toContain(tag);
		}
		expect(html).not.toContain("canonical");
		expect(html).not.toContain(NOTE_ID);
	});

	it("render a note's management page without indexing it", async () => {
		const res = await makeApp().request(`/note/${NOTE_ID}/manage`);
		const html = await res.text();

		expect(res.status).toBe(200);
		expect(html).toContain("<title>Secret — Delete the note</title>");
		expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
		expect(html).not.toContain('name="description"');
	});

	it("answer the shell with a 404 for any other path, the client router's to render", async () => {
		const app = makeApp();

		for (const path of ["/nope", "/index.html", `/note/${NOTE_ID}/manage/more`, "/_app/x.js"]) {
			const res = await app.request(path);
			const html = await res.text();

			expect(res.status).toBe(404);
			expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
			expect(res.headers.get("cache-control")).toBe("no-cache");
			expect(html).toContain("<title>404 | Secret</title>");
			expect(html).toContain('<meta property="og:site_name" content="Secret" />');
		}
	});

	it.each([
		[`/note/${NOTE_ID}/`, `/note/${NOTE_ID}`],
		[`/note/${NOTE_ID}/?x=1&next=//evil.example/`, `/note/${NOTE_ID}?x=1&next=//evil.example/`],
		[`/note/${NOTE_ID}/manage/`, `/note/${NOTE_ID}/manage`],
		[`/note/${NOTE_ID}/manage/?a=b`, `/note/${NOTE_ID}/manage?a=b`],
		["/note/%2F%2Fevil.example/", "/note/%2F%2Fevil.example"],
	])("send %s to %s with a 308, as SvelteKit did", async (path, location) => {
		const app = makeApp();

		for (const method of ["GET", "HEAD"]) {
			const res = await app.request(path, { method });

			expect(res.status).toBe(308);
			expect(res.headers.get("location")).toBe(location);
			expect(await res.text()).toBe("");
		}
	});

	it("never redirect a path that is no page's, off-site least of all", async () => {
		const app = makeApp();

		for (const path of [
			"//evil.example/",
			"//evil.example/note/x/",
			"/note//evil.example/",
			"/nope/",
			`/note/${NOTE_ID}/more/`,
		]) {
			const res = await app.request(path);

			expect(res.status).toBe(404);
			expect(res.headers.get("location")).toBeNull();
		}
	});

	it("answer HEAD like GET, without a body", async () => {
		const app = makeApp();

		for (const [path, status] of [
			["/", 200],
			["/nope", 404],
		] as const) {
			const res = await app.request(path, { method: "HEAD" });
			expect(res.status).toBe(status);
			expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
			expect(await res.text()).toBe("");
		}
	});

	it.each([
		["/", "home"],
		[`/note/${NOTE_ID}`, "note"],
		[`/note/${NOTE_ID}/manage`, "manage"],
		["/nope", "notFound"],
	] as const)("title %s as the page titles itself, by pageTitle", async (path, page) => {
		const html = await (await makeApp({ APP_NAME: "Vault" }).request(path)).text();
		const expected = pageTitle(page, "Vault", (key) => MESSAGES["en"]?.[key] ?? key);

		expect(html).toContain(`<title>${expected}</title>`);
	});

	it("render each page once per language and theme", async () => {
		const app = makeApp();

		const first = await (await app.request("/")).text();
		const second = await (await app.request("/")).text();

		expect(second).toBe(first);
	});
});

describe("the static files", () => {
	const START = "/_app/immutable/entry/start.Bx1.js";

	it("serve a file of the build, cached for good under _app/immutable", async () => {
		const res = await makeApp().request(START);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(res.headers.get("etag")).toBe(site.files.get(START)?.etag);
		expect(await res.text()).toBe(FILES["_app/immutable/entry/start.Bx1.js"]);
	});

	it.each([
		["/og.png", "image/png", "public, max-age=3600"],
		["/wasm/cap_wasm_bg.wasm", "application/wasm", "public, max-age=3600"],
		["/_app/version.json", "application/json", "no-cache"],
		["/bundle.json", "application/json", "no-cache"],
		["/_app/immutable/assets/inter.Dx4.woff2", "font/woff2", "public, max-age=31536000, immutable"],
	])("serve %s as %s, %s", async (path, type, cacheControl) => {
		const res = await makeApp().request(path);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe(type);
		expect(res.headers.get("cache-control")).toBe(cacheControl);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(
			new Uint8Array(site.files.get(path)?.body ?? []),
		);
	});

	it("answer 304 to a client that holds the file", async () => {
		const app = makeApp();
		const etag = site.files.get(START)?.etag as string;

		for (const ifNoneMatch of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
			const res = await app.request(START, { headers: { "If-None-Match": ifNoneMatch } });

			expect(res.status).toBe(304);
			expect(res.headers.get("etag")).toBe(etag);
			expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
			expect(await res.text()).toBe("");
		}

		const stale = await app.request(START, { headers: { "If-None-Match": '"other"' } });
		expect(stale.status).toBe(200);
	});

	describe("compressed once, at startup", () => {
		const APP = "/_app/immutable/entry/app.Cd2.js";
		const sha256 = createHash("sha256")
			.update(FILES["_app/immutable/entry/app.Cd2.js"] as string)
			.digest("hex");

		it.each([
			["gzip, deflate, br, zstd", "br"],
			["gzip", "gzip"],
			["br;q=0, gzip", "gzip"],
			["*", "br"],
		])("send for %o the %s copy, with an ETag of its own", async (acceptEncoding, encoding) => {
			const res = await makeApp().request(APP, { headers: { "Accept-Encoding": acceptEncoding } });

			expect(res.status).toBe(200);
			expect(res.headers.get("content-encoding")).toBe(encoding);
			expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
			expect(res.headers.get("vary")).toContain("Accept-Encoding");
			expect(res.headers.get("etag")).toBe(`"${sha256}-${encoding}"`);
			expect((await decodedBody(res)).toString()).toBe(FILES["_app/immutable/entry/app.Cd2.js"]);
		});

		it.each(["deflate", "identity", "br;q=0, gzip;q=0", "*;q=0"])(
			"send for %o the file as it is, never compressing it per request",
			async (acceptEncoding) => {
				const res = await makeApp().request(APP, {
					headers: { "Accept-Encoding": acceptEncoding },
				});

				expect(res.headers.get("content-encoding")).toBeNull();
				expect(res.headers.get("vary")).toContain("Accept-Encoding");
				expect(res.headers.get("etag")).toBe(`"${sha256}"`);
				expect(await res.text()).toBe(FILES["_app/immutable/entry/app.Cd2.js"]);
			},
		);

		it("revalidate each copy by its own ETag", async () => {
			const app = makeApp();
			const brotli = { "Accept-Encoding": "br" };

			const held = await app.request(APP, {
				headers: { ...brotli, "If-None-Match": `"${sha256}-br"` },
			});
			expect(held.status).toBe(304);
			expect(held.headers.get("etag")).toBe(`"${sha256}-br"`);
			expect(held.headers.get("vary")).toContain("Accept-Encoding");
			expect(held.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
			expect(held.headers.get("content-encoding")).toBeNull();
			expect(held.headers.get("content-type")).toBeNull();
			expect(await held.text()).toBe("");

			// The client holds the file as it is, and now accepts brotli: it gets the copy.
			const other = await app.request(APP, {
				headers: { ...brotli, "If-None-Match": `"${sha256}"` },
			});
			expect(other.status).toBe(200);
			expect(other.headers.get("content-encoding")).toBe("br");
		});

		it("answer HEAD with the copy's headers, without a body", async () => {
			const res = await makeApp().request(APP, {
				method: "HEAD",
				headers: { "Accept-Encoding": "br" },
			});

			expect(res.status).toBe(200);
			expect(res.headers.get("content-encoding")).toBe("br");
			expect(res.headers.get("etag")).toBe(`"${sha256}-br"`);
			expect(await res.text()).toBe("");
		});

		it("leave as they are the files that do not compress", async () => {
			const res = await makeApp().request("/og.png", {
				headers: { "Accept-Encoding": "gzip, deflate, br" },
			});

			expect(res.headers.get("content-encoding")).toBeNull();
			expect(res.headers.get("vary") ?? "").not.toContain("Accept-Encoding");
			expect(res.headers.get("etag")).toBe(site.files.get("/og.png")?.etag);
		});

		it("send a page compressed once too, in the coding the visitor accepts", async () => {
			const app = makeApp();
			const identity = await (await app.request("/")).text();

			const res = await app.request("/", { headers: { "Accept-Encoding": "gzip, br" } });
			expect(res.headers.get("content-encoding")).toBe("br");
			expect(res.headers.get("vary")).toContain("Accept-Language, Cookie, Accept-Encoding");
			expect((await decodedBody(res)).toString()).toBe(identity);

			const gzip = await app.request("/nope", { headers: { "Accept-Encoding": "gzip" } });
			expect(gzip.status).toBe(404);
			expect(gzip.headers.get("content-encoding")).toBe("gzip");
			expect((await decodedBody(gzip)).toString()).toContain("<title>404 | Secret</title>");

			const deflate = await app.request("/", { headers: { "Accept-Encoding": "deflate" } });
			expect(deflate.headers.get("content-encoding")).toBeNull();
			expect(await deflate.text()).toBe(identity);
		});
	});

	it("answer HEAD with the file's headers, without a body", async () => {
		const res = await makeApp().request("/favicon.svg", { method: "HEAD" });

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/svg+xml");
		expect(res.headers.get("etag")).toBe(site.files.get("/favicon.svg")?.etag);
		expect(await res.text()).toBe("");
	});

	it("answer a file the build lacks with the 404 shell", async () => {
		const res = await makeApp().request("/wasm/missing.wasm");

		expect(res.status).toBe(404);
		expect(await res.text()).toContain("<title>404 | Secret</title>");
	});

	it("never serve a file of the build on the API's paths", async () => {
		const shadowing = createSiteFixture({
			files: { ...FILES, "api/v1/leak.txt": "leak", "robots.txt": "User-agent: none\n" },
		});
		try {
			const app = makeApp({}, loadSite({ ...shadowing, logger: silent }));

			const leak = await app.request("/api/v1/leak.txt");
			expect(leak.status).toBe(404);
			expect(await leak.json()).toEqual(problemOf(404, "not_found", "Not found"));

			expect(await (await app.request("/robots.txt")).text()).toContain("Disallow: /api/");
		} finally {
			shadowing.remove();
		}
	});
});

describe("the API beside the site", () => {
	it("keeps its problem details for an unknown API path", async () => {
		const app = makeApp();

		for (const path of ["/api", "/api/nope", "/api/v1/nope"]) {
			const res = await app.request(path);
			expect(res.status).toBe(404);
			expect(res.headers.get("content-type")).toBe("application/problem+json");
			expect(await res.json()).toEqual(problemOf(404, "not_found", "Not found"));
		}
	});

	it("answers problem details to a method the pages do not take", async () => {
		const res = await makeApp().request("/nope", { method: "POST" });

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual(problemOf(404, "not_found", "Not found"));
	});

	it("reports the digest of the web app served", async () => {
		const res = await makeApp().request("/api/health");

		expect(await res.json()).toMatchObject({ bundle: fixture.digest });
	});

	it("keeps exactly the headers it had without the site, compression included", async () => {
		const headersOf = async (app: Hono<AppEnv>, path: string) => {
			const res = await app.request(path, { headers: { "Accept-Encoding": "gzip" } });
			const headers = Object.fromEntries(res.headers);
			delete headers["x-request-id"];
			return headers;
		};
		const withSite = makeApp();
		const alone = makeApp({}, null);

		for (const path of [
			"/api/v1/config",
			"/api/v1/openapi.json",
			"/api/nope",
			"/robots.txt",
			"/api/v1/docs",
		]) {
			expect(await headersOf(withSite, path)).toEqual(await headersOf(alone, path));
		}
		expect((await headersOf(withSite, "/api/v1/openapi.json"))["content-encoding"]).toBe("gzip");
	});
});

describe("the site's security headers", () => {
	it.each([
		["/", "same-origin"],
		[`/note/${NOTE_ID}`, "same-origin"],
		["/nope", "same-origin"],
		["/missing.png", "same-origin"],
		["/_app/immutable/entry/start.Bx1.js", "same-origin"],
		["/wasm/cap_wasm_bg.wasm", "same-origin"],
		["/bundle.json", "same-origin"],
		// Shown by other sites: a link's preview, its icon.
		["/og.png", "cross-origin"],
		["/favicon.svg", "cross-origin"],
	])("protect %s, its resource policy %s", async (path, resourcePolicy) => {
		const res = await makeApp().request(path);

		expect(res.headers.get("content-security-policy")).toBe(SITE_CSP);
		expect(res.headers.get("strict-transport-security")).toBe(
			"max-age=63072000; includeSubDomains; preload",
		);
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
		expect(res.headers.get("cross-origin-resource-policy")).toBe(resourcePolicy);
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		const permissions = res.headers.get("permissions-policy") ?? "";
		for (const feature of [
			"camera",
			"microphone",
			"geolocation",
			"gyroscope",
			"magnetometer",
			"accelerometer",
			"payment",
			"usb",
		]) {
			expect(permissions).toContain(`${feature}=()`);
		}
	});

	it("let other sites show the link preview however it is asked for", async () => {
		const app = makeApp();
		const etag = site.files.get("/og.png")?.etag as string;

		const requests = [
			app.request("/og.png", { method: "HEAD" }),
			app.request("/og.png", { headers: { "If-None-Match": etag } }),
			app.request("/favicon.svg", { headers: { "Accept-Encoding": "br" } }),
		];
		for (const res of await Promise.all(requests)) {
			expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
		}
	});
});

describe("the site's logs and metrics", () => {
	it("log pages and failures by route pattern, never a file served or a note id", async () => {
		const lines: Array<Record<string, unknown>> = [];
		const logger = createLogger({ write: (_level, line) => lines.push(JSON.parse(line)) });
		const config = parseConfig({
			SERVER_ENCRYPTION_KEY: SERVER_KEY.toString("base64"),
			APP_URL,
		} as NodeJS.ProcessEnv);
		const created = createApp({
			db,
			serverKey: SERVER_KEY,
			storage: new LocalStorage(TEST_FILES_PATH),
			config,
			logger,
			site,
		});
		stops.push(() => {
			for (const limiter of created.rateLimiters) limiter.cleanup();
		});
		const { app } = created;
		const etag = site.files.get("/favicon.svg")?.etag as string;

		await app.request("/favicon.svg");
		await app.request("/favicon.svg", { headers: { "If-None-Match": etag } });
		await app.request("/_app/immutable/entry/start.Bx1.js");
		await app.request(`/note/${NOTE_ID}`);
		await app.request("/_app/immutable/gone.js");
		await app.request(`/nope/${NOTE_ID}`);

		const requests = lines.filter((line) => line["msg"] === "request");
		expect(requests.map(({ route, status }) => ({ route, status }))).toEqual([
			{ route: "/note/:id", status: 200 },
			{ route: "/_app/*", status: 404 },
			// The wildcard middleware's pattern, as for any path nothing routes.
			{ route: "/*", status: 404 },
		]);
		expect(JSON.stringify(lines)).not.toContain(NOTE_ID);
	});

	it("count by route pattern, a few for the whole build", async () => {
		const app = makeApp({ METRICS_TOKEN });

		for (const path of [
			"/",
			`/note/${NOTE_ID}`,
			"/favicon.svg",
			"/og.png",
			"/wasm/cap_wasm_bg.wasm",
			"/_app/immutable/entry/start.Bx1.js",
			"/_app/immutable/entry/app.Cd2.js",
			"/api/v1/config",
		]) {
			await app.request(path);
		}
		const scrape = await app.request("/api/metrics", {
			headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
		});
		const routes = new Set(
			[...(await scrape.text()).matchAll(/secret_http_requests_total\{[^}]*route="([^"]*)"/g)].map(
				(match) => match[1],
			),
		);

		expect(routes).toEqual(
			new Set([
				"/",
				"/note/:id",
				"/favicon.svg",
				"/og.png",
				"/wasm/*",
				"/_app/*",
				"/api/v1/config",
			]),
		);
	});
});
