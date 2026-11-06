import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LOCALES } from "@largerio/secret-shared/site";

/** SvelteKit's boot script, as a static build inlines it in the shell. */
export const BOOT_SCRIPT = `
				{ __sveltekit_1abc = { base: "" }; const element = document.currentScript.parentElement; Promise.all([import("/_app/immutable/entry/start.Bx1.js"), import("/_app/immutable/entry/app.Cd2.js")]).then(([kit, app]) => { kit.start(app, element); }); }
			`;

/** The shell the web app's build writes, markers and all. */
export const SHELL = `<!doctype html>
<html lang="en" data-mode="system">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<link rel="icon" href="/favicon.svg" />
		<!--secret:head-->
		<link rel="modulepreload" href="/_app/immutable/entry/start.Bx1.js">
		<link rel="stylesheet" href="/_app/immutable/assets/app.Cs3.css">
	</head>
	<body data-sveltekit-preload-data="hover">
		<div style="display: contents">
			<script>${BOOT_SCRIPT}</script>
		</div>
	</body>
</html>
`;

/** The build's other files, by path. */
export const FILES: Readonly<Record<string, string | Uint8Array>> = {
	"_app/immutable/entry/start.Bx1.js": "export const start = () => {};\n",
	"_app/immutable/entry/app.Cd2.js": `export const app = "${"x".repeat(2048)}";\n`,
	"_app/immutable/assets/app.Cs3.css": "body{margin:0}\n",
	"_app/immutable/assets/inter.Dx4.woff2": Uint8Array.of(0x77, 0x4f, 0x46, 0x32),
	"_app/version.json": '{"version":"1762460000000"}',
	"favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
	"og.png": Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
	"wasm/cap_wasm_bg.wasm": Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00),
};

/** English in full, French in part (the rest falls back), the other languages empty. */
export const MESSAGES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	en: {
		seo_title: "{app} — Encrypted sharing",
		seo_description: "Share secrets: encrypted in your browser.",
		seo_keywords: "encrypted notes, secret sharing",
		view_title: "Encrypted note",
		view_description: "Decrypted in your browser, never on the server.",
		manage_title: "Delete the note",
	},
	fr: {
		seo_title: "{app} — Partage chiffré",
		seo_description: "Partagez des secrets : chiffrés dans votre navigateur.",
		view_title: "Note chiffrée",
	},
};

export interface SiteFixture {
	readonly buildDir: string;
	readonly messagesDir: string;
	/** The digest of the build, computed as bundle.ts's `sha256sum` pipeline would. */
	readonly digest: string;
	/** Write a file of the build, or of the messages with `messages/` in front. */
	write(path: string, content: string | Uint8Array): void;
	remove(): void;
}

function sha256Hex(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * A build of the web app and its messages in a directory of their own, with
 * the bundle.json the build writes unless `manifest` is false.
 */
export function createSiteFixture(
	options: {
		readonly shell?: string;
		readonly files?: Readonly<Record<string, string | Uint8Array>>;
		readonly manifest?: boolean;
	} = {},
): SiteFixture {
	const root = mkdtempSync(join(tmpdir(), "secret-site-"));
	const buildDir = join(root, "build");
	const messagesDir = join(root, "messages");

	function writeIn(dir: string, path: string, content: string | Uint8Array): void {
		const target = join(dir, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}

	const files: Record<string, string | Uint8Array> = {
		"index.html": options.shell ?? SHELL,
		...(options.files ?? FILES),
	};
	for (const [path, content] of Object.entries(files)) {
		writeIn(buildDir, path, content);
	}

	const listing = Object.keys(files)
		.sort()
		.map((path) => `${sha256Hex(files[path] as string | Uint8Array)}  ${path}\n`)
		.join("");
	const digest = `sha256:${sha256Hex(listing)}`;
	if (options.manifest ?? true) {
		writeIn(buildDir, "bundle.json", JSON.stringify({ version: 1, digest, files: [] }));
	}

	for (const locale of LOCALES) {
		writeIn(messagesDir, `${locale}.json`, JSON.stringify(MESSAGES[locale] ?? {}));
	}

	return {
		buildDir,
		messagesDir,
		digest,
		write(path, content) {
			if (path.startsWith("messages/")) {
				writeIn(messagesDir, path.slice("messages/".length), content);
				return;
			}
			writeIn(buildDir, path, content);
		},
		remove() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
