#!/usr/bin/env sh
# Smoke-test the artifact that actually gets published.
#
# Nothing else in the suite loads dist/: the unit tests import src/, so a broken
# bundle, a missing file or a .d.ts referencing a private workspace package
# would ship unnoticed. That last one did — every TypeScript consumer got TS2307
# on `@largerio/secret-shared`, including on the README example.
set -eu

PKG_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# pnpm, not npm: only pnpm applies `publishConfig`, and that is what
# `changeset publish` uses. `npm pack` leaves `exports` pointing at
# ./src/index.ts — a path that is not even in the tarball.
echo "→ packing"
cd "$PKG_DIR"
pnpm pack --pack-destination "$WORK" > /dev/null
TARBALL=$(ls "$WORK"/*.tgz | head -1)

echo "→ installing the tarball into a clean project"
mkdir -p "$WORK/consumer/src"
cd "$WORK/consumer"
cat > package.json <<'JSON'
{ "name": "sdk-consumer", "version": "1.0.0", "private": true, "type": "module" }
JSON
mkdir -p node_modules/@largerio/secret-sdk
tar -xzf "$TARBALL" -C node_modules/@largerio/secret-sdk --strip-components=1

echo "→ checking the published entry points resolve"
node -e "
const pkg = require('$WORK/consumer/node_modules/@largerio/secret-sdk/package.json');
const target = pkg.exports?.['.']?.import;
if (target !== './dist/index.js') {
  throw new Error('exports[\".\"].import is ' + JSON.stringify(target) + ' — publishConfig was not applied');
}
"

echo "→ checking the published files are present"
for f in dist/index.js dist/index.d.ts README.md LICENSE; do
	[ -f "node_modules/@largerio/secret-sdk/$f" ] || {
		echo "FAIL: $f missing from the tarball"
		exit 1
	}
done

# dist/index.js imports chunks of its own: statically what every call needs,
# with import() the crypto (src/engine.ts), which only creating or reading a
# note loads. Every chunk it reaches must be in the tarball, and none that it
# imports statically may import libsodium or MessagePack: a client that only
# checks and deletes notes, the web app's note page for one, would load them
# for nothing.
echo "→ checking the chunks, and that the crypto loads only on demand"
cat > "$WORK/chunks.cjs" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const dist = process.argv[2];
const CRYPTO = ["libsodium-wrappers-sumo", "@msgpack/msgpack"];
// esbuild writes a module's imports first, one declaration each.
const STATIC = /^(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const fail = (message) => {
	console.error(`FAIL: ${message}`);
	process.exit(1);
};
const specifiers = (file, pattern) =>
	[...fs.readFileSync(path.join(dist, file), "utf8").matchAll(pattern)].map((m) => m[1] ?? m[2]);
const isChunk = (specifier) => specifier.startsWith("./");

/** The files `entries` import statically, themselves included, and the packages they import. */
function closure(entries) {
	const files = new Set();
	const packages = new Set();
	const queue = [...entries];
	while (queue.length > 0) {
		const file = queue.shift();
		if (files.has(file)) continue;
		if (!fs.existsSync(path.join(dist, file))) fail(`dist/${file} is missing from the tarball`);
		files.add(file);
		for (const specifier of specifiers(file, STATIC)) {
			if (isChunk(specifier)) queue.push(path.posix.normalize(specifier));
			else packages.add(specifier);
		}
	}
	return { files, packages };
}
const bytes = (files) => [...files].reduce((sum, f) => sum + fs.statSync(path.join(dist, f)).size, 0);

const always = closure(["index.js"]);
const loaded = [...always.files].flatMap((file) => specifiers(file, DYNAMIC));
if (loaded.length === 0 || !loaded.every(isChunk)) {
	fail(`dist/index.js loads ${JSON.stringify(loaded)} on demand, not a chunk of its own`);
}
const onDemand = closure(loaded.map((s) => path.posix.normalize(s)));
for (const name of CRYPTO) {
	if (always.packages.has(name)) fail(`dist/index.js imports ${name} statically`);
	if (!onDemand.packages.has(name)) fail(`the chunk loaded on demand does not import ${name}`);
}
const extra = [...onDemand.files].filter((f) => !always.files.has(f));
console.log(`  every call: ${[...always.files].join(", ")} (${bytes(always.files)} bytes)`);
console.log(`  on demand, with the crypto: ${extra.join(", ")} (${bytes(extra)} bytes)`);
JS
node "$WORK/chunks.cjs" node_modules/@largerio/secret-sdk/dist

# The bundle was 40 KB once zod left it, 800 KB while one schema import kept it
# in. The budget, over every chunk, leaves room to grow and still trips on a
# heavy dependency slipping in through crypto or shared.
MAX_BUNDLE_BYTES=98304
echo "→ checking the bundle stays under $MAX_BUNDLE_BYTES bytes"
BUNDLE_BYTES=$(cat node_modules/@largerio/secret-sdk/dist/*.js | wc -c | tr -d ' ')
if [ "$BUNDLE_BYTES" -gt "$MAX_BUNDLE_BYTES" ]; then
	echo "FAIL: dist/*.js is $BUNDLE_BYTES bytes, over the $MAX_BUNDLE_BYTES budget"
	exit 1
fi

echo "→ checking the types are self-contained"
# Only module specifiers count — prose in a doc comment may legitimately name
# the shared package.
if grep -qE "(from|import\()[[:space:]]*['\"]@largerio/secret-(shared|crypto)" \
	node_modules/@largerio/secret-sdk/dist/index.d.ts; then
	echo "FAIL: dist/index.d.ts imports from a private workspace package"
	grep -nE "(from|import\()[[:space:]]*['\"]@largerio/secret-" \
		node_modules/@largerio/secret-sdk/dist/index.d.ts
	exit 1
fi

echo "→ typechecking a consumer against the published types"
cat > tsconfig.json <<'JSON'
{
	"compilerOptions": {
		"strict": true,
		"module": "ESNext",
		"moduleResolution": "bundler",
		"target": "ES2022",
		"noEmit": true,
		"skipLibCheck": false,
		"types": []
	},
	"include": ["src"]
}
JSON
cat > src/consumer.ts <<'TS'
import {
	SecretApiError,
	SecretClient,
	SecretDecryptionError,
	SecretNetworkError,
	type ContentMode,
	type NoteInfo,
	type NotePayload,
} from "@largerio/secret-sdk";

// A client at once, without the crypto, which a call loads when it needs it.
export function check(baseUrl: string, id: string): Promise<NoteInfo> {
	return new SecretClient({ baseUrl }).checkNote(id);
}

export async function roundTrip(baseUrl: string): Promise<NotePayload | null> {
	const client = await SecretClient.create({ baseUrl });
	const mode: ContentMode = "markdown";

	const { id, keyFragment } = await client.createNote({ text: "# hi", contentMode: mode });

	const info: NoteInfo = await client.checkNote(id);
	if (!info.exists) return null;
	// Narrowing must expose the metadata fields.
	if (info.hasPassword && info.maxReads > 0 && info.chunked) return null;

	const parsed = SecretClient.parseShareUrl(client.buildShareUrl(id, keyFragment));

	try {
		const { payload } = await client.readNote(parsed.id, parsed.keyFragment);
		return payload;
	} catch (err) {
		if (err instanceof SecretDecryptionError) return null;
		if (err instanceof SecretNetworkError) return null;
		if (err instanceof SecretApiError && err.status === 404) return null;
		throw err;
	}
}
TS
"$PKG_DIR/../../node_modules/.bin/tsc" -p tsconfig.json

# Neither runtime dependency is installed yet: checking a note must not need
# them, and SecretClient.create(), which loads the crypto first, must.
echo "→ checking a note with neither runtime dependency installed"
node -e "
import('@largerio/secret-sdk').then(async ({ SecretClient }) => {
  const asked = [];
  const client = new SecretClient({
    baseUrl: 'https://example.invalid',
    fetch: async (url) => {
      asked.push(String(url));
      return Response.json({ exists: false });
    },
  });
  const info = await client.checkNote('aBcDeFgHiJkL');
  if (info.exists !== false || asked.join() !== 'https://example.invalid/api/v1/notes/aBcDeFgHiJkL/exists') {
    throw new Error('checkNote: ' + JSON.stringify({ info, asked }));
  }
  const created = await SecretClient.create().then(() => true, () => false);
  if (created) throw new Error('SecretClient.create() did not load the crypto first');
  console.log('  new SecretClient() + checkNote ok without them; create() loads them');
});
"

# The bundle keeps these two external (they are real dependencies of the
# published package); a genuine `npm install` would fetch them, so link the
# workspace copies to stand in for that. If either were missing from
# "dependencies", the import below would fail here — which is the point.
echo "→ linking the declared runtime dependencies"
mkdir -p node_modules/@msgpack
ln -s "$PKG_DIR/node_modules/@msgpack/msgpack" node_modules/@msgpack/msgpack
ln -s "$PKG_DIR/node_modules/libsodium-wrappers-sumo" node_modules/libsodium-wrappers-sumo

echo "→ importing the bundle at runtime"
node -e "
import('@largerio/secret-sdk').then(async (m) => {
  if (typeof m.SecretClient?.create !== 'function') throw new Error('SecretClient.create missing');
  const client = await m.SecretClient.create({ baseUrl: 'https://example.invalid' });
  const url = client.buildShareUrl('aBcDeFgHiJkL', 'k3y');
  const back = m.SecretClient.parseShareUrl(url);
  if (back.id !== 'aBcDeFgHiJkL' || back.keyFragment !== 'k3y') {
    throw new Error('buildShareUrl/parseShareUrl do not round-trip: ' + JSON.stringify(back));
  }
  console.log('  runtime import + share-URL round-trip ok');
});
"

echo "package verification passed"
