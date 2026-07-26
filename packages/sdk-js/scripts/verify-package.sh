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
