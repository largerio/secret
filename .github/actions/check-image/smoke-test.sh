#!/usr/bin/env bash
# Boot an image the way a PaaS would and check that the site, its API proxy and
# its CSRF check all behave. Every image is run through this before it gets a
# tag: the e2e suite runs on an image built from the same sources, not on this
# digest.
#
# Usage: [EXPECTED_VERSION=<version>] smoke-test.sh <image-ref>
# The image must be built with REVISION, as CI builds it (Dockerfile). Given
# EXPECTED_VERSION, the version /api/health reports must be that one.
set -euo pipefail

IMAGE=$1

secrets_dir=$(mktemp -d)
chmod 755 "$secrets_dir"
trap 'docker rm -f smoke smoke-keyed > /dev/null 2>&1 || true; rm -rf "$secrets_dir"' EXIT

fail() {
	echo "FAIL: $1"
	docker logs "${2:-smoke}"
	exit 1
}

# Two containers, since the API refuses a secret given both as NAME and as
# NAME_FILE: one that starts with zero config and generates its server key,
# one whose operator brings the key. Between them they set every variable
# entrypoint.sh keeps from the web process. Each gets its arguments in `args`;
# `given` lists the secrets its API must see. The values are random, since
# written here they would read as leaked keys.
args=()
given=()
plain() {
	args+=(-e "$1=${2:-$(openssl rand -hex 24)}")
	given+=("$1")
}
# From a file, as a Docker secret would hand it: readable by the container's
# uid 1001.
from_file() {
	openssl rand -hex 24 > "$secrets_dir/$1"
	chmod 644 "$secrets_dir/$1"
	args+=(-e "$1_FILE=/run/secrets/$1" -v "$secrets_dir/$1:/run/secrets/$1:ro")
	given+=("$1_FILE")
}
sorted() { printf '%s\n' "$@" | LC_ALL=C sort | xargs; }

# Every PaaS injects PORT. The generated server key goes to the API by its
# file: no environment holds the key itself. KEY_FILE names where it lives.
args=(-e PORT=10000 -p 10000:10000)
given=(SERVER_ENCRYPTION_KEY_FILE)
plain KEY_FILE /app/data/.encryption_key
plain API_KEY
plain API_KEY_1
from_file API_KEY_2
from_file S3_ACCESS_KEY_ID
from_file S3_SECRET_ACCESS_KEY
from_file METRICS_TOKEN
plain AWS_ACCESS_KEY_ID
docker run -d --name smoke "${args[@]}" "$IMAGE" > /dev/null
smoke_secrets=$(sorted "${given[@]}")

# Boots alongside: it is only checked at the end.
args=(-e PORT=10001 -p 10001:10001)
given=()
plain SERVER_ENCRYPTION_KEY "$(openssl rand -base64 32)"
from_file API_KEY
plain API_KEY_3
from_file API_KEY_10
plain S3_ACCESS_KEY_ID
plain S3_SECRET_ACCESS_KEY
plain METRICS_TOKEN
plain AWS_SECRET_ACCESS_KEY
plain AWS_SESSION_TOKEN
docker run -d --name smoke-keyed "${args[@]}" "$IMAGE" > /dev/null
keyed_secrets=$(sorted "${given[@]}")

wait_ready() {
	for _ in $(seq 30); do
		if curl -fsS "http://localhost:$2/api/health/ready" > /dev/null 2>&1; then return; fi
		sleep 2
	done
	fail "$1 never got ready" "$1"
}
wait_ready smoke 10000

echo "--- the site must be served on PORT, not the raw API ---"
# Read whole first: grep -q leaving early would break curl's pipe.
page=$(curl -fsS http://localhost:10000/) || fail "PORT does not serve the web app"
grep -q "<!doctype html" <<< "$page" || fail "PORT does not serve the web app"
echo "--- and its proxy must reach the API ---"
health=$(curl -fsS http://localhost:10000/api/health) || fail "the web app cannot reach the API"
grep -q '"status":"ok"' <<< "$health" || fail "the web app cannot reach the API"
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
# What the SDK sends from Node: no Origin header. These must reach the API,
# which answers 401 unauthenticated, not SvelteKit's form CSRF check (403).
echo "--- API writes must reach the API, not SvelteKit's CSRF check ---"
for probe in "-X POST -F probe=1 http://localhost:10000/api/v1/notes/upload" \
	"-X DELETE http://localhost:10000/api/v1/notes/AAAAAAAAAAAA"; do
	# shellcheck disable=SC2086 # $probe is a list of curl arguments
	code=$(curl -s -o /dev/null -w '%{http_code}' $probe)
	[ "$code" = "401" ] || fail "curl $probe answered $code, expected 401"
done
# Past the key check, the empty note fails validation: 400, not 401.
echo "--- an API key read from a file must authorize writes ---"
api_key=$(cat "$secrets_dir/API_KEY_2")
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $api_key" \
	-H "Content-Type: application/json" -d '{}' http://localhost:10000/api/v1/notes)
[ "$code" = "400" ] || fail "a write with API_KEY_2_FILE's key answered $code"
# Burned by its only read, which purges its file: the purge is counted by the
# storage the API wraps at startup, in the registry /api/metrics serves.
echo "--- a file note must be created, read and purged ---"
openssl rand 64 > "$secrets_dir/payload"
metadata="{\"clientNonce\":\"$(openssl rand -base64 24)\",\"hasPassword\":false,\"expiresIn\":3600,\"maxReads\":1,\"fileCount\":1}"
note=$(curl -fsS -X POST -H "Authorization: Bearer $api_key" --form-string "metadata=$metadata" \
	-F "data=@$secrets_dir/payload" http://localhost:10000/api/v1/notes/upload) \
	|| fail "a file note could not be created"
id=$(jq -r .id <<< "$note")
curl -fsS -o /dev/null "http://localhost:10000/api/v1/notes/$id/raw" \
	|| fail "the file note could not be read"
echo "--- the probes must answer, the metrics only with their token ---"
for probe in /api/health/live /api/health/ready; do
	curl -fsS "http://localhost:10000$probe" > /dev/null || fail "$probe is not ready"
done
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:10000/api/metrics)
[ "$code" = "401" ] || fail "/api/metrics without its token answered $code"
metrics=$(curl -fsS -H "Authorization: Bearer $(cat "$secrets_dir/METRICS_TOKEN")" \
	http://localhost:10000/api/metrics) || fail "/api/metrics refused its token"
for series in "secret_build_info{version=\"$version\",revision=\"$revision\"} 1" \
	'secret_http_requests_total{method="POST",route="/api/v1/notes/upload",status="2xx"} 1' \
	'secret_notes_created_total{type="file"} 1' \
	'secret_notes_burned_total 1' \
	'secret_storage_purges_total{result="ok"} 1'; do
	grep -qxF "$series" <<< "$metrics" || fail "/api/metrics has no $series"
done
# adapter-node 6 dropped ORIGIN and defaults to https: on plain HTTP the
# app would reject its own form posts. The image derives the origin from
# APP_URL (here its default, http://localhost:PORT) — while SvelteKit's
# CSRF check must still refuse a foreign origin.
echo "--- the app's origin must follow APP_URL, its CSRF check must still hold ---"
same=$(curl -s -o /dev/null -w '%{http_code}' -X POST -F probe=1 \
	-H "Origin: http://localhost:10000" http://localhost:10000/)
cross=$(curl -s -o /dev/null -w '%{http_code}' -X POST -F probe=1 \
	-H "Origin: https://evil.example" http://localhost:10000/)
if [ "$same" = "403" ] || [ "$cross" != "403" ]; then
	fail "same-origin POST $same, cross-origin POST $cross"
fi

wait_ready smoke-keyed 10001
echo "--- with the server key given, API_KEY_FILE must authorize writes ---"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
	-H "Authorization: Bearer $(cat "$secrets_dir/API_KEY")" \
	-H "Content-Type: application/json" -d '{}' http://localhost:10001/api/v1/notes)
[ "$code" = "400" ] || fail "a write with API_KEY_FILE's key answered $code" smoke-keyed

# The API's secrets must reach the API, and only the API.
echo "--- the web process must not see the API's secrets ---"
# Every variable entrypoint.sh keeps from the web process.
removed='^((SERVER_ENCRYPTION_KEY|API_KEY(_[0-9]+)?|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY|METRICS_TOKEN)(_FILE)?|KEY_FILE|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)='
environ() {
	# "node <script>" never appears whole in this shell's own command line, so
	# pgrep matches the process alone. Not anchored: under emulation, the
	# command line starts with qemu.
	docker exec "$1" sh -c 'tr "\0" "\n" < "/proc/$(pgrep -f "node $1" | head -n 1)/environ"' sh "$2"
}
# Names only, never values.
secret_names() { grep -oE "$removed" | tr -d = | LC_ALL=C sort | xargs; }
check_secrets() {
	local api_env web_env api web
	# Read first, so a process that is not found fails the test instead of
	# counting no secrets.
	api_env=$(environ "$1" apps/api/dist/index.js) || { echo "FAIL: no API process in $1"; return 1; }
	web_env=$(environ "$1" apps/web/dist/server/index.js) || { echo "FAIL: no web process in $1"; return 1; }
	api=$(secret_names <<< "$api_env" || true)
	web=$(secret_names <<< "$web_env" || true)
	if [ "$api" != "$2" ] || [ -n "$web" ]; then
		echo "FAIL: in $1, the API sees [$api], not [$2]; the web process sees [$web]"
		return 1
	fi
}
# Both, so a failure shows which start leaks what.
leaks=0
check_secrets smoke "$smoke_secrets" || leaks=1
check_secrets smoke-keyed "$keyed_secrets" || leaks=1
[ "$leaks" = "0" ] || exit 1
