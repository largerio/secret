#!/usr/bin/env sh
# Smoke-test the artifact that actually gets published, as the SDK's script
# does for the SDK (packages/sdk-js/scripts/verify-package.sh).
#
# The unit tests import src/ and nothing else runs dist/bin.js, where a missing
# shebang, a `workspace:` range left in the manifest or an import of a private
# workspace package would ship unnoticed. So the command runs here from the two
# tarballs alone, its own and the SDK's it depends on, laid out as an install
# lays them out. Build both packages first.
set -eu

PKG_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
SDK_DIR=$(CDPATH='' cd -- "$PKG_DIR/../sdk-js" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail() {
	echo "FAIL: $*"
	exit 1
}

[ -f "$SDK_DIR/dist/index.js" ] ||
	fail "the SDK is not built: pnpm --filter @largerio/secret-sdk build"

# pnpm, not npm: only pnpm applies `publishConfig` and writes `workspace:^` as a
# version range, and `changeset publish` publishes through pnpm. The SDK is
# packed too, so the command runs against the SDK it will be published with.
echo "→ packing the CLI and the SDK"
mkdir "$WORK/cli" "$WORK/sdk"
(cd "$PKG_DIR" && pnpm pack --pack-destination "$WORK/cli" > /dev/null)
(cd "$SDK_DIR" && pnpm pack --pack-destination "$WORK/sdk" > /dev/null)
set -- "$WORK"/cli/*.tgz
CLI_TARBALL=$1
set -- "$WORK"/sdk/*.tgz
SDK_TARBALL=$1

echo "→ checking the published files"
tar -tzf "$CLI_TARBALL" | sort > "$WORK/files"
for f in package.json dist/bin.js README.md LICENSE; do
	grep -qx "package/$f" "$WORK/files" || fail "$f missing from the tarball"
done
# The bundle, the manifest and its docs: no source, no map, no test.
if grep -vxE 'package/(package\.json|README\.md|LICENSE|CHANGELOG\.md|dist/[^/]+\.js)' \
	"$WORK/files" > "$WORK/unexpected"; then
	fail "unexpected files in the tarball: $(tr '\n' ' ' < "$WORK/unexpected")"
fi

# Laid out as npm does: both packages at the top, the SDK's own dependencies
# under it. The CLI can then load the SDK and nothing else, as under pnpm's
# strict layout. A genuine install would fetch the SDK's dependencies; the
# workspace copies stand in for them, at the versions of the lockfile.
echo "→ installing the tarballs into a clean project"
CONSUMER=$WORK/consumer
CLI=$CONSUMER/node_modules/@largerio/secret-cli
SDK=$CONSUMER/node_modules/@largerio/secret-sdk
mkdir -p "$CLI" "$SDK" "$CONSUMER/node_modules/.bin"
cat > "$CONSUMER/package.json" <<'JSON'
{ "name": "cli-consumer", "version": "1.0.0", "private": true, "type": "module" }
JSON
tar -xzf "$CLI_TARBALL" -C "$CLI" --strip-components=1
tar -xzf "$SDK_TARBALL" -C "$SDK" --strip-components=1

echo "→ checking the published manifest"
cat > "$WORK/manifest.cjs" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const [cliDir, sdkDir, cliSource, sdkSource] = process.argv.slice(2);
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const cli = read(cliDir);
const sdk = read(sdkDir);
const fail = (message) => {
	console.error(`FAIL: ${message}`);
	process.exit(1);
};

const bin = typeof cli.bin === "string" ? { [cli.name.split("/").pop()]: cli.bin } : cli.bin;
if (path.posix.normalize(bin?.secret ?? "") !== "dist/bin.js") {
	fail(`bin.secret is ${JSON.stringify(bin?.secret)}, not ./dist/bin.js`);
}

// publishConfig.exports replaces the workspace's, which points at src/.
if (/\.\/src\/|\.ts"/.test(JSON.stringify(cli.exports ?? null))) {
	fail(`exports still points at the sources: ${JSON.stringify(cli.exports)}: publishConfig was not applied`);
}

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
	for (const [name, range] of Object.entries(cli[field] ?? {})) {
		if (range.startsWith("workspace:")) fail(`${field}.${name} is ${range}`);
	}
}

// What `workspace:^` becomes: a range the SDK packed with it satisfies, so an
// install takes that SDK. Only the forms pnpm writes are accepted.
const range = cli.dependencies?.["@largerio/secret-sdk"];
const match = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(range ?? "");
const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(sdk.version);
if (!match || !version) {
	fail(`the SDK dependency is ${JSON.stringify(range)}, not a range pnpm writes, for SDK ${sdk.version}`);
}
const [, operator, ...floor] = match;
const [want, have] = [floor.map(Number), version.slice(1).map(Number)];
const atLeast = have[0] - want[0] || have[1] - want[1] || have[2] - want[2];
const same = (n) => want.slice(0, n).every((part, i) => part === have[i]);
const caretFixed = want[0] > 0 ? 1 : want[1] > 0 ? 2 : 3;
const fixed = operator === "^" ? caretFixed : operator === "~" ? 2 : 3;
if (atLeast < 0 || !same(fixed)) {
	fail(`the SDK dependency ${range} does not take the SDK ${sdk.version} it is published with`);
}

// The SDK's dependencies, linked from the workspace under the SDK.
for (const name of Object.keys(sdk.dependencies ?? {})) {
	const target = path.join(sdkDir, "node_modules", name);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.symlinkSync(fs.realpathSync(path.join(sdkSource, "node_modules", name)), target);
}
// And the CLI's, should it have any besides the SDK.
for (const name of Object.keys(cli.dependencies ?? {})) {
	if (name === "@largerio/secret-sdk") continue;
	const target = path.join(cliDir, "node_modules", name);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.symlinkSync(fs.realpathSync(path.join(cliSource, "node_modules", name)), target);
}

console.log(cli.version);
JS
CLI_VERSION=$(node "$WORK/manifest.cjs" "$CLI" "$SDK" "$PKG_DIR" "$SDK_DIR")

echo "→ checking the entry point"
[ "$(head -n 1 "$CLI/dist/bin.js")" = "#!/usr/bin/env node" ] ||
	fail "dist/bin.js does not start with #!/usr/bin/env node"

echo "→ checking the bundle imports the SDK and no private package"
# Only module specifiers count: prose in a string may name a package. A static
# import would also fail the run below; a dynamic one only once it is reached.
SPECIFIER="(from|import|import[[:space:]]*\(|require[[:space:]]*\()[[:space:]]*['\"]"
if grep -nE "$SPECIFIER@largerio/secret-(shared|crypto)" "$CLI"/dist/*.js; then
	fail "dist imports a private workspace package"
fi
# Kept external (tsup.config.ts): inlined, the SDK would bring libsodium into
# the bundle with it, and an SDK fix would need a release of the CLI.
grep -qE "$SPECIFIER@largerio/secret-sdk['\"]" "$CLI"/dist/*.js ||
	fail "dist does not import @largerio/secret-sdk: the SDK was inlined, or is not used"

# Twice the 62 KB of the first release: room to grow that still trips on a
# dependency inlined by mistake (the SDK alone is 75 KB, libsodium megabytes).
MAX_BUNDLE_BYTES=126976
echo "→ checking the bundle stays under $MAX_BUNDLE_BYTES bytes"
BUNDLE_BYTES=$(cat "$CLI"/dist/*.js | wc -c | tr -d ' ')
if [ "$BUNDLE_BYTES" -gt "$MAX_BUNDLE_BYTES" ]; then
	fail "dist is $BUNDLE_BYTES bytes, over the $MAX_BUNDLE_BYTES budget"
fi

# As npm and pnpm do on install: a link in .bin, the target made executable.
ln -s ../@largerio/secret-cli/dist/bin.js "$CONSUMER/node_modules/.bin/secret"
chmod +x "$CLI/dist/bin.js"

# From the clean project, with none of the caller's environment: no
# SECRET_INSTANCE, no key, nothing from the workspace.
secret() {
	(cd "$CONSUMER" && env -i PATH="$PATH" HOME="$WORK" node_modules/.bin/secret "$@")
}

echo "→ running the command"
VERSION=$(secret --version) || fail "secret --version exited with $?"
[ "$VERSION" = "$CLI_VERSION" ] ||
	fail "secret --version printed '$VERSION', the package is $CLI_VERSION"

status=0
secret --help > "$WORK/help" || status=$?
[ "$status" -eq 0 ] || fail "secret --help exited with $status"
[ -s "$WORK/help" ] || fail "secret --help printed nothing on stdout"

status=0
secret no-such-command > "$WORK/stdout" 2> "$WORK/stderr" || status=$?
[ "$status" -eq 2 ] || fail "an unknown command exited with $status, not 2 (usage)"
[ -s "$WORK/stderr" ] || fail "an unknown command said nothing on stderr"
[ ! -s "$WORK/stdout" ] || fail "an unknown command wrote to stdout"

# The commands above run the help's chunk alone: none of them loads the SDK.
# This one loads it and libsodium, whose WASM module the client waits for,
# then fails to reach an address where nothing listens, without a network: a
# dependency missing from the install, or one that does not load, ends it
# otherwise. Its link has a fragment, which check ignores.
UNREACHABLE=http://127.0.0.1:9
status=0
secret check "$UNREACHABLE/note/aBcDeFgHiJkL#1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" \
	> "$WORK/stdout" 2> "$WORK/stderr" || status=$?
[ "$status" -eq 1 ] ||
	fail "secret check of an unreachable instance exited with $status, not 1: $(cat "$WORK/stderr")"
grep -qF "could not reach $UNREACHABLE" "$WORK/stderr" ||
	fail "secret check of an unreachable instance said: $(cat "$WORK/stderr")"
[ ! -s "$WORK/stdout" ] || fail "secret check of an unreachable instance wrote to stdout"
echo "  secret $VERSION: --version, --help, an unknown command and the SDK ok"

echo "package verification passed"
