#!/usr/bin/env bash
# Boot an image the way a PaaS would and check that it serves the site and the
# API on PORT, from one process, and the web app its bundle.json names. Every
# image is run through this before it gets a tag: the e2e suite runs on an
# image built from the same sources, not on this digest.
#
# Usage: [EXPECTED_VERSION=<version>] smoke-test.sh <image-ref>
# The image must be built with REVISION, as CI builds it (Dockerfile). Given
# EXPECTED_VERSION, the version /api/health reports must be that one.
set -euo pipefail

IMAGE=$1
MANIFEST=/app/apps/web/build/bundle.json
# The instance that starts with zero config, as its pages name it.
BASE=http://localhost:10000

work=$(mktemp -d)
chmod 755 "$work"
trap 'docker rm -f smoke smoke-keyed > /dev/null 2>&1 || true; rm -rf "$work"' EXIT

fail() {
	echo "FAIL: $1"
	docker logs "${2:-smoke}"
	exit 1
}

# From a file, as a Docker secret would hand it: readable by the container's
# uid 1001. Random, since written here it would read as a leaked key.
from_file() {
	openssl rand -hex 24 > "$work/$1"
	chmod 644 "$work/$1"
	args+=(-e "$1_FILE=/run/secrets/$1" -v "$work/$1:/run/secrets/$1:ro")
}

# Two containers, since the API refuses a secret given both as NAME and as
# NAME_FILE: one that starts with zero config and generates its server key,
# one whose operator brings the key. Every PaaS injects PORT.
args=(-e PORT=10000 -p 10000:10000)
from_file API_KEY_2
from_file METRICS_TOKEN
docker run -d --name smoke "${args[@]}" "$IMAGE" > /dev/null

# Boots alongside: it is only checked at the end. It keeps what an instance of
# 1.7 or older may still set for its internal API, which must open nothing.
args=(-e PORT=10001 -p 10001:10001 -e "SERVER_ENCRYPTION_KEY=$(openssl rand -base64 32)"
	-e API_PORT=3001 -e API_HOST=0.0.0.0 -e API_URL=http://127.0.0.1:3001)
from_file API_KEY
docker run -d --name smoke-keyed "${args[@]}" "$IMAGE" > /dev/null

wait_ready() {
	for _ in $(seq 30); do
		if curl -fsS "http://localhost:$2/api/health/ready" > /dev/null 2>&1; then return; fi
		sleep 2
	done
	fail "$1 never got ready" "$1"
}

# A response whole, read before it is checked: grep -q leaving early would
# break curl's pipe. Prints the status; the headers and the body are left in
# $work/headers and $work/body.
fetch() {
	curl -sS -D "$work/headers" -o "$work/body" -w '%{http_code}' "$@"
}
# A header's value, empty when the response has none.
header() {
	{ grep -i "^$1:" "$work/headers" || true; } | head -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'
}
# Whether the response fetched answered <status> with HTML: is_html <code> <status>.
is_html() {
	[ "$1" = "$2" ] && [[ $(header content-type) == text/html* ]]
}
# The TCP ports the container listens on, from its own network namespace:
# state 0A is LISTEN, the port the hex after the address' colon.
listening() {
	docker exec "$1" sh -c 'cat /proc/net/tcp /proc/net/tcp6 2> /dev/null; true' \
		| awk '$4 == "0A" { split($2, local, ":"); print local[2] }' | sort -u \
		| while read -r hex; do printf '%d\n' "0x$hex"; done | xargs
}
# PID 1's command line or environment, a line per entry.
pid1() {
	docker exec "$1" sh -c 'tr "\0" "\n" < "/proc/1/$1"' sh "$2"
}

wait_ready smoke 10000

echo "--- one process, the API, on PORT alone ---"
# Exec'd by entrypoint.sh, so Docker's signals reach it. Not anchored: under
# emulation, the command line starts with qemu.
command=$(pid1 smoke cmdline | xargs) || fail "PID 1 cannot be read"
grep -qF "node apps/api/dist/index.js" <<< "$command" || fail "PID 1 is [$command], not the API"
ports=$(listening smoke) || fail "the ports of the container cannot be read"
[ "$ports" = "10000" ] || fail "the container listens on [$ports], not on PORT alone"
echo "--- the generated server key must reach the API by its file ---"
# Names only, never values: no environment may hold the key itself.
keys=$(pid1 smoke environ | grep -oE '^SERVER_ENCRYPTION_KEY(_FILE)?=' | tr -d = | xargs || true)
[ "$keys" = "SERVER_ENCRYPTION_KEY_FILE" ] || fail "the API gets the server key as [$keys]"

echo "--- PORT must serve the shell, rendered, under a CSP by hashes ---"
code=$(fetch "$BASE/") || fail "/ cannot be fetched"
is_html "$code" 200 || fail "/ answered $code $(header content-type)"
grep -qi "<!doctype html" "$work/body" || fail "/ is not an HTML document"
# The shell data, which the server writes into the page (packages/shared/src/
# site.ts). Its JSON escapes every <, so it ends at the first one.
shell=$(grep -oE '<script[^>]*id="secret-shell"[^>]*>[^<]*' "$work/body" || true)
grep -q 'type="application/json"' <<< "$shell" || fail "/ carries no shell data"
app_name=$(jq -r .config.appName <<< "${shell#*>}") || fail "/ carries shell data that is not JSON"
[ "$app_name" = "Secret" ] || fail "the shell data names the app $app_name, not APP_NAME's default"
# The head the server writes names the instance by APP_URL, here its default.
grep -qF "<link rel=\"canonical\" href=\"$BASE\"" "$work/body" || fail "/ does not give $BASE as its address"
csp=$(header content-security-policy)
[[ $csp == *"'sha256-"* ]] || fail "the CSP of / lists no script hash: $csp"
[[ $csp == *"frame-ancestors 'none'"* ]] || fail "the CSP of / lets the page be framed: $csp"
# Fingerprinted by the build, so cached for good.
asset=$(grep -oE '/_app/immutable/[^"?#]+' "$work/body" | head -n 1 || true)
[ -n "$asset" ] || fail "/ loads nothing from /_app/immutable/"
code=$(fetch "$BASE$asset") || fail "$asset cannot be fetched"
[ "$code" = "200" ] || fail "$asset answered $code"
[[ $(header cache-control) == *immutable* ]] || fail "$asset is cached as [$(header cache-control)]"
echo "--- a note's page is the shell, an unknown page a 404 ---"
code=$(fetch "$BASE/note/abcdefghijkl") || fail "a note's page cannot be fetched"
is_html "$code" 200 || fail "a note's page answered $code $(header content-type)"
code=$(fetch "$BASE/no-such-page") || fail "an unknown page cannot be fetched"
is_html "$code" 404 || fail "an unknown page answered $code $(header content-type)"

echo "--- the API must answer on PORT ---"
health=$(curl -fsS "$BASE/api/health") || fail "/api/health does not answer"
grep -q '"status":"ok"' <<< "$health" || fail "/api/health is not ok: $health"
echo "--- and serve the web app its bundle.json names ---"
# What the API computed from the files at startup, against the build's own
# manifest, which /bundle.json serves.
built=$(docker exec smoke cat "$MANIFEST" | jq -r .digest) || fail "the image has no $MANIFEST"
[[ $built =~ ^sha256:[0-9a-f]{64}$ ]] || fail "$MANIFEST names the digest $built"
served=$(jq -r .bundle <<< "$health")
[ "$served" = "$built" ] || fail "/api/health reports the bundle $served, $MANIFEST is $built"
public=$(curl -fsS "$BASE/bundle.json" | jq -r .digest) || fail "/bundle.json is not served"
[ "$public" = "$built" ] || fail "/bundle.json names $public, the image's is $built"
echo "--- the API must name its build, and leave the storage used to the metrics ---"
version=$(jq -r .version <<< "$health")
revision=$(jq -r .revision <<< "$health")
# CHANGELOG.md's latest version, -dev on a later commit (apps/api/src/buildInfo.ts).
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
	|| fail "/api/health reports the version $version"
if [ -n "${EXPECTED_VERSION:-}" ] && [ "$version" != "$EXPECTED_VERSION" ]; then
	fail "/api/health reports the version $version, not $EXPECTED_VERSION"
fi
# CI labels the image with the commit it passes as REVISION (deploy.yml,
# rebuild-release.yml), and release-image.yml promotes such an image.
labelled=$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' smoke)
if ! [[ $revision =~ ^[0-9a-f]{7,64}$ ]] || { [ -n "$labelled" ] && [ "$revision" != "$labelled" ]; }; then
	fail "/api/health reports the revision $revision, the image is labelled ${labelled:-with none}"
fi
if grep -q usedBytes <<< "$health"; then
	fail "/api/health reports the storage used"
fi
# What the SDK sends from Node: no Origin header. Refused for their missing
# token, and nothing else.
echo "--- API writes without a token must answer 401 ---"
for probe in "-X POST -F probe=1 $BASE/api/v1/notes/upload" \
	"-X DELETE $BASE/api/v1/notes/AAAAAAAAAAAA"; do
	# shellcheck disable=SC2086 # $probe is a list of curl arguments
	code=$(fetch $probe) || fail "curl $probe failed"
	[ "$code" = "401" ] || fail "curl $probe answered $code, expected 401"
done
# Past the key check, the empty note fails validation: 400, not 401.
echo "--- an API key read from a file must authorize writes ---"
api_key=$(cat "$work/API_KEY_2")
code=$(fetch -X POST -H "Authorization: Bearer $api_key" \
	-H "Content-Type: application/json" -d '{}' "$BASE/api/v1/notes") \
	|| fail "a write with API_KEY_2_FILE's key failed"
[ "$code" = "400" ] || fail "a write with API_KEY_2_FILE's key answered $code"
# Burned by its only read, which purges its file: the purge is counted by the
# storage the API wraps at startup, in the registry /api/metrics serves.
echo "--- a file note must be created, read and purged ---"
openssl rand 64 > "$work/payload"
metadata="{\"clientNonce\":\"$(openssl rand -base64 24)\",\"hasPassword\":false,\"expiresIn\":3600,\"maxReads\":1,\"fileCount\":1}"
note=$(curl -fsS -X POST -H "Authorization: Bearer $api_key" --form-string "metadata=$metadata" \
	-F "data=@$work/payload" "$BASE/api/v1/notes/upload") \
	|| fail "a file note could not be created"
id=$(jq -r .id <<< "$note")
curl -fsS -o /dev/null "$BASE/api/v1/notes/$id/raw" \
	|| fail "the file note could not be read"
echo "--- the probes must answer, the metrics only with their token ---"
for probe in /api/health/live /api/health/ready; do
	curl -fsS "$BASE$probe" > /dev/null || fail "$probe is not ready"
done
code=$(fetch "$BASE/api/metrics") || fail "/api/metrics cannot be fetched"
[ "$code" = "401" ] || fail "/api/metrics without its token answered $code"
metrics=$(curl -fsS -H "Authorization: Bearer $(cat "$work/METRICS_TOKEN")" \
	"$BASE/api/metrics") || fail "/api/metrics refused its token"
for series in "secret_build_info{version=\"$version\",revision=\"$revision\"} 1" \
	'secret_http_requests_total{method="POST",route="/api/v1/notes/upload",status="2xx"} 1' \
	'secret_notes_created_total{type="file"} 1' \
	'secret_notes_burned_total 1' \
	'secret_storage_purges_total{result="ok"} 1'; do
	grep -qxF "$series" <<< "$metrics" || fail "/api/metrics has no $series"
done

wait_ready smoke-keyed 10001
echo "--- with the server key given, API_KEY_FILE must authorize writes ---"
code=$(fetch -X POST -H "Authorization: Bearer $(cat "$work/API_KEY")" \
	-H "Content-Type: application/json" -d '{}' http://localhost:10001/api/v1/notes) \
	|| fail "a write with API_KEY_FILE's key failed" smoke-keyed
[ "$code" = "400" ] || fail "a write with API_KEY_FILE's key answered $code" smoke-keyed
echo "--- the internal API's settings must open no port, and be warned about ---"
ports=$(listening smoke-keyed) || fail "the ports of the container cannot be read" smoke-keyed
[ "$ports" = "10001" ] || fail "with API_PORT and API_HOST set, the container listens on [$ports]" smoke-keyed
logs=$(docker logs smoke-keyed 2>&1)
for name in API_PORT API_HOST API_URL; do
	grep -q "WARNING: $name is set" <<< "$logs" || fail "no warning that $name is no longer used" smoke-keyed
done
