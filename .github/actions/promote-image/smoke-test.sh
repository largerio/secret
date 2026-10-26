#!/usr/bin/env bash
# Boot an image the way a PaaS would and check that the site, its API proxy and
# its CSRF check all behave. Every image is run through this before it gets a
# tag: the e2e suite runs the dev servers, so nothing else exercises the image.
#
# Usage: smoke-test.sh <image-ref>
set -euo pipefail

IMAGE=$1

# Every PaaS injects PORT. The API keys and the S3 secret are only there to be
# looked for in the web process below: random, since written here they would
# read as leaked keys. API_KEY_2 comes from a file, as a Docker secret would,
# readable by the container's uid 1001.
key_file=$(mktemp)
trap 'rm -f "$key_file"' EXIT
openssl rand -hex 24 > "$key_file"
chmod 644 "$key_file"
docker run -d --name smoke -e PORT=10000 -p 10000:10000 \
	-e API_KEY_1="$(openssl rand -hex 24)" -e S3_SECRET_ACCESS_KEY="$(openssl rand -hex 16)" \
	-e API_KEY_2_FILE=/run/secrets/api_key -v "$key_file:/run/secrets/api_key:ro" \
	"$IMAGE"
for _ in $(seq 30); do
	if curl -fsS http://localhost:10000/api/health > /dev/null 2>&1; then break; fi
	sleep 2
done
echo "--- the site must be served on PORT, not the raw API ---"
curl -fsS http://localhost:10000/ | grep -q "<!doctype html" \
	|| { echo "FAIL: PORT does not serve the web app"; docker logs smoke; exit 1; }
echo "--- and its proxy must reach the API ---"
curl -fsS http://localhost:10000/api/health | grep -q '"status":"ok"' \
	|| { echo "FAIL: the web app cannot reach the API"; docker logs smoke; exit 1; }
# What the SDK sends from Node: no Origin header. These must reach the API,
# which answers 401 unauthenticated, not SvelteKit's form CSRF check (403).
echo "--- API writes must reach the API, not SvelteKit's CSRF check ---"
for probe in "-X POST -F probe=1 http://localhost:10000/api/v1/notes/upload" \
	"-X DELETE http://localhost:10000/api/v1/notes/AAAAAAAAAAAA"; do
	# shellcheck disable=SC2086 # $probe is a list of curl arguments
	code=$(curl -s -o /dev/null -w '%{http_code}' $probe)
	[ "$code" = "401" ] \
		|| { echo "FAIL: curl $probe answered $code, expected 401"; docker logs smoke; exit 1; }
done
# Past the key check, the empty note fails validation: 400, not 401.
echo "--- an API key read from a file must authorize writes ---"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $(cat "$key_file")" \
	-H "Content-Type: application/json" -d '{}' http://localhost:10000/api/v1/notes)
[ "$code" = "400" ] \
	|| { echo "FAIL: a write with API_KEY_2_FILE's key answered $code"; docker logs smoke; exit 1; }
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
	echo "FAIL: same-origin POST $same, cross-origin POST $cross"; docker logs smoke; exit 1
fi
# The API's secrets must reach the API, and only the API. The generated server
# key goes by its file, like API_KEY_2: no environment holds the key itself.
echo "--- the web process must not see the API's secrets ---"
environ() {
	# "node <script>" never appears whole in this shell's own command line, so
	# pgrep matches the process alone. Not anchored: under emulation, the
	# command line starts with qemu.
	docker exec smoke sh -c 'tr "\0" "\n" < "/proc/$(pgrep -f "node $1" | head -n 1)/environ"' sh "$1"
}
secrets='^(SERVER_ENCRYPTION_KEY|SERVER_ENCRYPTION_KEY_FILE|API_KEY_1|API_KEY_2_FILE|S3_SECRET_ACCESS_KEY)='
# Read first, so a process that is not found fails the test instead of
# counting no secrets.
api_env=$(environ apps/api/dist/index.js)
web_env=$(environ apps/web/dist/server/index.js)
api=$(grep -cE "$secrets" <<< "$api_env" || true)
web=$(grep -cE "$secrets" <<< "$web_env" || true)
# 4: the key's file, API_KEY_1, API_KEY_2's file and the S3 secret. A fifth
# would be the key itself.
if [ "$api" != "4" ] || [ "$web" != "0" ]; then
	echo "FAIL: the API sees $api of its 4 secrets, the web process $web"; docker logs smoke; exit 1
fi
docker rm -f smoke
