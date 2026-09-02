#!/usr/bin/env sh
# Smoke-test the artifact that actually gets published.
#
# The unit tests import src/ and stub the SDK, so a bin file without its
# shebang, a bundle that inlined the SDK (or failed to import it), or a
# `files` list missing dist/ would ship unnoticed. This packs the CLI and the
# SDK it depends on, installs both into a clean project and runs the binary.
set -eu

PKG_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SDK_DIR="$PKG_DIR/../sdk-js"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# pnpm, not npm: only pnpm applies `publishConfig`, and that is what
# `changeset publish` uses — the SDK's exports would otherwise point at
# ./src/index.ts, a path that is not even in its tarball.
echo "→ packing the CLI and the SDK"
mkdir -p "$WORK/cli" "$WORK/sdk"
(cd "$PKG_DIR" && pnpm pack --pack-destination "$WORK/cli" > /dev/null)
(cd "$SDK_DIR" && pnpm build > /dev/null && pnpm pack --pack-destination "$WORK/sdk" > /dev/null)
CLI_TARBALL=$(ls "$WORK"/cli/*.tgz | head -1)
SDK_TARBALL=$(ls "$WORK"/sdk/*.tgz | head -1)

echo "→ installing both tarballs into a clean project"
CONSUMER="$WORK/consumer"
CLI_INSTALL="$CONSUMER/node_modules/@largerio/secret-cli"
SDK_INSTALL="$CONSUMER/node_modules/@largerio/secret-sdk"
mkdir -p "$CLI_INSTALL" "$SDK_INSTALL"
tar -xzf "$CLI_TARBALL" -C "$CLI_INSTALL" --strip-components=1
tar -xzf "$SDK_TARBALL" -C "$SDK_INSTALL" --strip-components=1

# The SDK keeps these two external; a real `npm install` would fetch them, so
# link the workspace copies to stand in for that.
mkdir -p "$CONSUMER/node_modules/@msgpack"
ln -s "$SDK_DIR/node_modules/@msgpack/msgpack" "$CONSUMER/node_modules/@msgpack/msgpack"
ln -s "$SDK_DIR/node_modules/libsodium-wrappers-sumo" "$CONSUMER/node_modules/libsodium-wrappers-sumo"

echo "→ checking the published files are present"
for f in dist/cli.js README.md LICENSE; do
	[ -f "$CLI_INSTALL/$f" ] || {
		echo "FAIL: $f missing from the tarball"
		exit 1
	}
done

echo "→ checking the bin entry"
BIN=$(node -e "console.log(require('$CLI_INSTALL/package.json').bin.secret)")
[ "$BIN" = "./dist/cli.js" ] || {
	echo "FAIL: bin.secret is '$BIN'"
	exit 1
}
[ "$(head -n 1 "$CLI_INSTALL/dist/cli.js")" = "#!/usr/bin/env node" ] || {
	echo "FAIL: dist/cli.js does not start with a shebang"
	exit 1
}

echo "→ checking the SDK stayed external"
grep -qE "from ['\"]@largerio/secret-sdk['\"]" "$CLI_INSTALL/dist/cli.js" || {
	echo "FAIL: dist/cli.js does not import @largerio/secret-sdk (was it inlined?)"
	exit 1
}
if grep -q "libsodium" "$CLI_INSTALL/dist/cli.js"; then
	echo "FAIL: dist/cli.js bundles the crypto layer"
	exit 1
fi

echo "→ running the binary"
cd "$CONSUMER"
SECRET="node $CLI_INSTALL/dist/cli.js"
EXPECTED=$(node -e "console.log(require('$CLI_INSTALL/package.json').version)")
ACTUAL=$($SECRET --version)
[ "$ACTUAL" = "$EXPECTED" ] || {
	echo "FAIL: --version printed '$ACTUAL', expected '$EXPECTED'"
	exit 1
}
$SECRET --help | grep -q "^Usage: secret" || {
	echo "FAIL: --help did not print usage"
	exit 1
}

# Exercises the SDK import at runtime end to end: the client initialises
# libsodium, then the request fails on a port nothing listens on. Exit 1 with
# the SDK's network error — not a crash — is the pass condition.
echo "→ checking a real SDK round-trip fails cleanly against a dead instance"
set +e
OUTPUT=$($SECRET check "http://127.0.0.1:9/note/aBcDeFgHiJkL" 2>&1)
STATUS=$?
set -e
[ "$STATUS" -eq 1 ] || {
	echo "FAIL: expected exit 1, got $STATUS: $OUTPUT"
	exit 1
}
echo "$OUTPUT" | grep -q "secret: Network request failed" || {
	echo "FAIL: unexpected output: $OUTPUT"
	exit 1
}
echo "  bin, shebang, external SDK and runtime import ok"

echo "package verification passed"
