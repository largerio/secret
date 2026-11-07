#!/usr/bin/env bash
# Check that an instance serves the web app of this checkout: run it from a
# checkout of the release's tag, once the web app is built
# (SECURITY.md#verifying-the-web-app). It checks that:
#
#   - the build is intact: its files make the digest its bundle.json names
#     (packages/shared/src/bundle.ts), and the release's digest when given;
#   - /api/health reports that digest as the instance's bundle;
#   - every file of the build but the shell, bundle.json included, is served
#     at its path, byte for byte;
#   - the shell, on the home page, a note's page, a note's deletion page and
#     an unknown page, names no address but the build's files and the
#     instance's own, and its Content-Security-Policy lets it run the
#     instance's files and the build's inline scripts, and no other script.
#
# It says what differs, and exits 1 when anything does.
#
# Usage: scripts/verify-web-app.sh <instance-url> [<release-digest>]
#   <instance-url>    the instance's address as it gives it, its APP_URL
#   <release-digest>  sha256:<hex>, as the release notes give it
#        scripts/verify-web-app.sh --digest-of <build-dir>
#   prints the digest of a build, recomputed from its files
#
# Needs bash, coreutils, curl and node.
set -euo pipefail

usage() {
	echo "Usage: $0 <instance-url> [<release-digest>]" >&2
	echo "       $0 --digest-of <build-dir>" >&2
	exit 2
}

# The files of a build but those named, a path a line, relative to it, sorted
# by byte.
paths_of() {
	local dir=$1 name
	shift
	local skip=()
	for name in "$@"; do
		skip+=(! -path "./$name")
	done
	(cd "$dir" && find . -type f ${skip[@]+"${skip[@]}"} | sed 's|^\./||' | LC_ALL=C sort)
}

# `<sha256>  <path>` for each path on stdin, relative to <dir>.
hashes_in() {
	(cd "$1" && tr '\n' '\0' | xargs -0 -r sha256sum --)
}

# The digest of a build: the SHA-256 of the listing of its files, bundle.json
# left out.
digest_of() {
	echo "sha256:$(paths_of "$1" bundle.json | hashes_in "$1" | sha256sum | cut -d' ' -f1)"
}

# A string member of the JSON document on stdin, empty when there is none.
json_member() {
	node -e '
		let value;
		try {
			value = JSON.parse(require("node:fs").readFileSync(0, "utf8"))[process.argv[1]];
		} catch {}
		process.stdout.write(typeof value === "string" ? value : "");
	' "$1"
}

if [ "${1:-}" = --digest-of ]; then
	[ "$#" -eq 2 ] || usage
	digest_of "$2"
	exit 0
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || [[ $1 == -* ]]; then
	usage
fi

INSTANCE=${1%/}
RELEASE=${2:-}
BUILD=$(cd "$(dirname "$0")/.." && pwd)/apps/web/build

for tool in curl node sha256sum; do
	if ! command -v "$tool" > /dev/null; then
		echo "This check needs $tool." >&2
		exit 2
	fi
done
if [ ! -f "$BUILD/bundle.json" ] || [ ! -f "$BUILD/index.html" ]; then
	echo "No build of the web app in $BUILD. From the checkout's root:" >&2
	echo "  pnpm install --frozen-lockfile && pnpm --filter @largerio/web build" >&2
	exit 2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
differs() {
	echo "  DIFFERS: $*"
	failures=$((failures + 1))
}

echo "The build, $BUILD:"
built=$(digest_of "$BUILD")
named=$(json_member digest < "$BUILD/bundle.json")
if [ "$built" != "$named" ]; then
	echo "  its bundle.json names ${named:-no digest}, its files make $built: it changed since it was built. Build it again." >&2
	exit 1
fi
if [ -n "$RELEASE" ] && [ "$RELEASE" != "$built" ]; then
	echo "  it is $built, not $RELEASE: is this checkout the release's tag?" >&2
	exit 1
fi
echo "  $built"

echo "What $INSTANCE says it serves:"
if ! health=$(curl -sS "$INSTANCE/api/health"); then
	echo "  $INSTANCE/api/health cannot be fetched." >&2
	exit 1
fi
reported=$(json_member bundle <<< "$health")
if [ "$reported" = "$built" ]; then
	echo "  /api/health reports the same digest."
else
	differs "/api/health reports ${reported:-no bundle}"
fi

# Every file of the build but the shell, over one connection: a path with
# any character a URL or curl's config could take for another is escaped.
paths_of "$BUILD" index.html > "$work/paths"
hashes_in "$BUILD" < "$work/paths" > "$work/expected"
quoted() {
	local value=${1//\\/\\\\}
	printf '"%s"' "${value//\"/\\\"}"
}
encoded() {
	local LC_ALL=C path=$1 char i
	for ((i = 0; i < ${#path}; i++)); do
		char=${path:i:1}
		case $char in
			[A-Za-z0-9._~/-]) printf '%s' "$char" ;;
			*) printf '%%%02X' "'$char" ;;
		esac
	done
}
while IFS= read -r path; do
	echo "url = $(quoted "$INSTANCE/$(encoded "$path")")"
	echo "output = $(quoted "$work/served/$path")"
done < "$work/paths" > "$work/curl.config"
# --compressed: the encodings a browser asks for, whose copies the instance
# compressed on its own. A file it does not serve is left out, and found
# missing below.
curl -sS --fail --compressed --create-dirs --config "$work/curl.config" || true
mkdir -p "$work/served"
count=$(wc -l < "$work/paths" | tr -d ' ')
if mismatches=$(cd "$work/served" && sha256sum --check --quiet "$work/expected" 2> /dev/null); then
	echo "  The $count files of the build but the shell are served the same."
else
	while IFS= read -r line; do
		case $line in
			*": FAILED open or read") differs "/${line%: FAILED open or read} is not served" ;;
			*": FAILED") differs "/${line%: FAILED} is served with other bytes" ;;
			*) differs "$line" ;;
		esac
	done <<< "$mismatches"
fi

# The inline scripts of the build's shell that a browser runs: those without
# src whose type is JavaScript's, `module` or none, as HTML has it. The rest,
# such as JSON, are data. Each one's CSP source, in the order of the page.
hashes=$(node - "$BUILD/index.html" <<'EOF'
const { createHash } = require("node:crypto");
const html = require("node:fs").readFileSync(process.argv[2], "utf8");
const runs = /^(|module|(application|text)\/(x-)?(ecma|java)script|text\/javascript1\.[0-5]|text\/(jscript|livescript))$/;
const sources = new Set();
for (const [, tag, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi)) {
	const attributes = new Map();
	for (const [, name, ...values] of tag.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
		attributes.set(name.toLowerCase(), values.find((value) => value !== undefined) ?? "");
	}
	if (attributes.has("src") || !runs.test((attributes.get("type") ?? "").trim().toLowerCase())) continue;
	sources.add(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
}
process.stdout.write([...sources].map((source) => ` ${source}`).join(""));
EOF
)
expected_policy="script-src 'self' 'wasm-unsafe-eval'$hashes"
sed 's|^|/|' "$work/paths" > "$work/addresses"

# A note's id, of the length of one: the instance cannot know it.
id=$(head -c 9 /dev/urandom | base64 | tr '+/' '-_')
for page in / "/note/$id" "/note/$id/manage" "/$id"; do
	echo "The shell, at $page:"
	if ! curl -sS --compressed -D "$work/headers" -o "$work/page" "$INSTANCE$page"; then
		differs "it cannot be fetched"
		continue
	fi

	# Every address in an attribute or the boot script: a file of the build,
	# or the instance's own address, in links that load nothing.
	strangers=$(tr "'" '"' < "$work/page" \
		| { grep -oiE '(src|href)[[:space:]]*=[[:space:]]*("[^"]*"|[^[:space:]">]+)|import\("[^"]*"\)' || true; } \
		| sed -E 's/^[^=(]*[=(][[:space:]]*"?//; s/"?\)?$//' | LC_ALL=C sort -u \
		| while IFS= read -r url; do
			if [ "$url" != "$INSTANCE" ] && ! grep -qxF -- "$url" "$work/addresses"; then
				echo "$url"
			fi
		done)
	if [ -z "$strangers" ]; then
		echo "  It names no address but the build's files and the instance's."
	else
		while IFS= read -r url; do
			differs "it names $url, which is not a file of the build"
		done <<< "$strangers"
	fi

	# Addresses the check above does not read, and the release's shell never
	# holds: a refresh sends the page elsewhere, a srcset lists images.
	if grep -qiE 'http-equiv[[:space:]]*=[[:space:]]*"?refresh|srcset[[:space:]]*=' "$work/page"; then
		differs "it holds a <meta http-equiv=\"refresh\"> or a srcset, which the release's shell does not"
	fi

	# One script-src, of the instance's files and the build's inline scripts:
	# script-src-elem or -attr would replace it.
	policy=$({ grep -i '^content-security-policy:' "$work/headers" || true; } | cut -d: -f2- \
		| tr -d '\r' | tr ';' '\n' | sed 's/^ *//; s/ *$//' | { grep -i '^script-src' || true; })
	if [ "$policy" = "$expected_policy" ]; then
		echo "  Its CSP runs no script but the instance's files and the build's inline scripts."
	else
		differs "its CSP has [${policy//$'\n'/; }], not [$expected_policy]"
	fi
done

if [ "$failures" -gt 0 ]; then
	echo "$INSTANCE does not serve this build: $failures difference(s) above."
	exit 1
fi
echo "$INSTANCE served this build, $built."
