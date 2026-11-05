#!/usr/bin/env bash
# Run the command line as its users get it, against an image started by
# e2e-image.sh: the CLI and the SDK packed as they would be published,
# installed with npm from those two tarballs, then `secret` from that install.
# Writes go by proof of work, as the browser's do, and by API key.
#
# Usage: E2E_API_KEY=<key> e2e-cli.sh <base-url>
#   E2E_API_KEY: the key e2e-image.sh started the image with.
# Build the SDK and the CLI first:
#   pnpm --filter @largerio/secret-sdk --filter @largerio/secret-cli build
set -euo pipefail

BASE_URL=${1:?usage: E2E_API_KEY=<key> e2e-cli.sh <base-url>}
BASE_URL=${BASE_URL%/}
: "${E2E_API_KEY:?must be the key e2e-image.sh started the image with}"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

OUT=$WORK/stdout
ERR=$WORK/stderr

# To stderr: a fail in a command substitution would print into a variable.
fail() {
	{
		echo "FAIL: $1"
		if [ -s "$ERR" ]; then
			echo "--- what the command said on stderr:"
			cat "$ERR"
		fi
		echo "--- the last logs of the image:"
		docker logs secret-e2e-app 2>&1 | tail -50 || true
	} >&2
	exit 1
}

# Only what each step sets: none of the caller's settings, no terminal, and
# the stack of an unexpected error.
unset SECRET_INSTANCE SECRET_API_KEY SECRET_API_KEY_FILE SECRET_PASSWORD
export SECRET_DEBUG=1
exec < /dev/null

# A command waiting on something that never comes fails here, rather than at
# the job's timeout. (macOS has no timeout(1).)
if command -v timeout > /dev/null; then
	within() { timeout 120 "$@"; }
else
	within() { "$@"; }
fi

# run [env NAME=value…] secret …: its stdout in $OUT, its stderr in $ERR, its
# exit code in $status.
run() {
	status=0
	within "$@" > "$OUT" 2> "$ERR" || status=$?
}

# expect <code> <what was run>
expect() {
	[ "$status" -ne 124 ] || fail "$2 did not finish within 120 seconds"
	[ "$status" -eq "$1" ] || fail "$2 exited with $status, not $1"
}

# json <dotted.path> [file]: a field of the JSON in the file, the last stdout
# by default.
json() {
	local file=${2:-$OUT}
	node -e '
		let value = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
		for (const key of process.argv[1].split(".")) value = value?.[key];
		if (value === undefined) process.exit(1);
		console.log(typeof value === "string" ? value : JSON.stringify(value));
	' "$1" "$file" || fail "no $1 in the JSON printed: $(cat "$file")"
}

sha256() {
	if command -v sha256sum > /dev/null; then
		sha256sum "$1" | cut -d ' ' -f 1
	else
		shasum -a 256 "$1" | cut -d ' ' -f 1
	fi
}

random() {
	openssl rand -hex "$1"
}

# The chunks the image has stored so far: its request log names the route
# pattern of each request (the container is e2e-image.sh's).
chunk_uploads() {
	docker logs secret-e2e-app 2>&1 |
		grep -c '"route":"/api/v1/notes/upload/:uploadId/chunks/:index","status":200' || true
}

docker inspect secret-e2e-app > /dev/null 2>&1 ||
	fail "no secret-e2e-app container: start the image with e2e-image.sh"

echo "→ packing the SDK and the CLI as they would be published"
mkdir "$WORK/packs"
for dir in sdk-js cli; do
	[ -d "$ROOT/packages/$dir/dist" ] || fail "packages/$dir is not built"
	(cd "$ROOT/packages/$dir" && pnpm pack --pack-destination "$WORK/packs" > /dev/null)
done
sdk_tarball=("$WORK"/packs/largerio-secret-sdk-*.tgz)
cli_tarball=("$WORK"/packs/largerio-secret-cli-*.tgz)

# The SDK's own dependencies come from the registry, as they do for a user,
# but none published less than two days ago: the age pnpm requires of the
# lockfile (minimumReleaseAge, pnpm-workspace.yaml). And no install script
# runs.
echo "→ installing them with npm into a clean project"
mkdir "$WORK/user"
cd "$WORK/user"
echo '{ "name": "cli-e2e", "version": "1.0.0", "private": true }' > package.json
before=$(node -e 'console.log(new Date(Date.now() - 2 * 864e5).toISOString())')
if ! npm install --no-audit --no-fund --ignore-scripts --before="$before" \
	"${sdk_tarball[0]}" "${cli_tarball[0]}" > "$WORK/npm.log" 2>&1; then
	cat "$WORK/npm.log" >&2
	fail "npm could not install the tarballs"
fi
# The range the CLI was packed with takes the SDK packed with it: npm
# installed no other copy for the CLI.
if [ -e node_modules/@largerio/secret-cli/node_modules/@largerio/secret-sdk ]; then
	fail "npm gave the CLI an SDK of its own: its range does not take the packed SDK"
fi
export PATH="$WORK/user/node_modules/.bin:$PATH"
[ "$(command -v secret)" = "$WORK/user/node_modules/.bin/secret" ] ||
	fail "secret is not the command npm installed"

cli_version=$(node -p 'require("./node_modules/@largerio/secret-cli/package.json").version')
run secret --version
expect 0 "secret --version"
[ "$(cat "$OUT")" = "$cli_version" ] ||
	fail "secret --version printed $(cat "$OUT"), the package is $cli_version"
echo "  secret $cli_version, on Node $(node --version), against $BASE_URL"

text=$WORK/text.txt
printf 'A note from the command line.\n\tAccents, emoji, CJK: é ü 🔐 日本\nNo newline at the end' \
	> "$text"

echo "→ a text note, written with a proof of work, read back"
run secret send --instance "$BASE_URL" < "$text"
expect 0 "secret send"
link=$(cat "$OUT")
if [ "$(wc -l < "$OUT" | tr -d ' ')" != 1 ] || [[ $link != "$BASE_URL/note/"*"#"* ]]; then
	fail "secret send printed something else than the link alone: $link"
fi
run secret read "$link"
expect 0 "secret read"
cmp "$OUT" "$text" >&2 || fail "secret read printed another text than the one sent"

echo "→ a note read once is gone"
run secret read "$link"
expect 3 "secret read of a note already read"
run secret check "$link"
expect 3 "secret check of a note already read"

echo "→ a file of several MiB, sent in chunks to S3, read into a directory"
# Larger than the SDK's default chunk of 4 MiB, so it goes in chunks, and these
# must be the instance's (CHUNK_SIZE, 1 MiB): it refuses larger ones. A format
# 1 note does not say it is chunked (check reports `chunked` for format 0
# only), so the chunks are counted in the image's request log.
head -c 6000000 /dev/urandom > "$WORK/large.bin"
chunks_before=$(chunk_uploads)
run env SECRET_INSTANCE="$BASE_URL" secret send --json "$WORK/large.bin"
expect 0 "secret send of a file"
link=$(json link)
chunks=$(($(chunk_uploads) - chunks_before))
[ "$chunks" -ge 6 ] || fail "6 MB went up in $chunks chunks, not 6 of 1 MiB at least"
run secret check "$link" --json
expect 0 "secret check of the file note"
[ "$(json fileCount)" = 1 ] || fail "the file note does not hold one file"
mkdir "$WORK/received"
run secret read "$link" --out "$WORK/received" --json
expect 0 "secret read --out"
[ "$(json files.0.name)" = large.bin ] || fail "the file came back as $(json files.0.name)"
[ "$(sha256 "$(json files.0.path)")" = "$(sha256 "$WORK/large.bin")" ] ||
	fail "the file written differs from the file sent"
# Nothing else, such as a .part file.
[ "$(find "$WORK/received" -type f | wc -l | tr -d ' ')" = 1 ] ||
	fail "secret read left other files in --out: $(ls -A "$WORK/received")"

echo "→ a password note: a wrong password is refused and spends no read"
password=$(random 12)
run env SECRET_PASSWORD="$password" secret send --instance "$BASE_URL" --password --json \
	< "$text"
expect 0 "secret send --password"
link=$(json link)
run env SECRET_PASSWORD="$(random 12)" secret read "$link"
expect 4 "secret read with a wrong password"
run secret check "$link" --json
expect 0 "secret check after a wrong password"
[ "$(json hasPassword)" = true ] || fail "the note has no password"
[ "$(json passwordAttemptsLeft)" = 4 ] ||
	fail "$(json passwordAttemptsLeft) password attempts left after one wrong, not 4"
run env SECRET_PASSWORD="$password" secret read "$link"
expect 0 "secret read with the password"
cmp "$OUT" "$text" >&2 || fail "secret read printed another text than the one sent"

echo "→ check spends nothing, delete takes the delete token"
run secret send --instance "$BASE_URL" --max-reads 2 --expires 1h --json < "$text"
expect 0 "secret send --max-reads 2 --expires 1h"
cp "$OUT" "$WORK/sent.json"
link=$(json link "$WORK/sent.json")
token=$(json deleteToken "$WORK/sent.json")
[ "$(json maxReads "$WORK/sent.json")" = 2 ] || fail "--max-reads 2 was not applied"
node -e '
	const left = (Date.parse(process.argv[1]) - Date.now()) / 1000;
	if (!(Math.abs(left - 3600) < 300)) {
		console.error("the note expires in " + left + "s");
		process.exit(1);
	}
' "$(json expiresAt "$WORK/sent.json")" || fail "--expires 1h was not applied"
for _ in 1 2 3; do
	run secret check "$link" --json
	expect 0 "secret check"
	[ "$(json readCount)" = 0 ] || fail "secret check spent a read"
done
run secret check "$link"
expect 0 "secret check, for a person"
[ -s "$OUT" ] || fail "secret check printed nothing"
# The same length and alphabet, so only the instance can tell it is wrong.
wrong_token=$(printf '%s' "$token" | tr 'A-Za-z0-9' 'B-ZAb-za1-90')
run secret delete "$link" --token "$wrong_token"
expect 4 "secret delete with a wrong token"
run secret delete "$link" --token "$token"
expect 0 "secret delete"
run secret check "$link"
expect 3 "secret check of a deleted note"
run secret delete "$link" --token "$token"
expect 3 "secret delete of a deleted note"

echo "→ writes with an API key, and no proof of work in place of a wrong one"
# As a secret file holds it: the value, then a line break.
printf '%s\n' "$E2E_API_KEY" > "$WORK/api-key"
run env SECRET_API_KEY_FILE="$WORK/api-key" secret send --instance "$BASE_URL" --max-reads 2 \
	--json < "$text"
expect 0 "secret send with SECRET_API_KEY_FILE"
cp "$OUT" "$WORK/sent.json"
link=$(json link "$WORK/sent.json")
run secret read "$link"
expect 0 "secret read of the note written by key"
cmp "$OUT" "$text" >&2 || fail "secret read printed another text than the one sent"
run env SECRET_API_KEY="$E2E_API_KEY" secret delete "$link" \
	--token "$(json deleteToken "$WORK/sent.json")"
expect 0 "secret delete with SECRET_API_KEY"
run secret check "$link"
expect 3 "secret check of a note deleted by key"
wrong_key=$(random 24)
run env SECRET_API_KEY="$wrong_key" secret send --instance "$BASE_URL" < "$text"
expect 4 "secret send with a wrong SECRET_API_KEY"
[ ! -s "$OUT" ] || fail "a refused send printed a link"
printf '%s\n' "$wrong_key" > "$WORK/wrong-key"
run env SECRET_API_KEY_FILE="$WORK/wrong-key" secret send --instance "$BASE_URL" < "$text"
expect 4 "secret send with a wrong SECRET_API_KEY_FILE"

echo "CLI e2e passed"
