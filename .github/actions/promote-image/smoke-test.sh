#!/usr/bin/env bash
# Boot an image the way a PaaS would and check that the site, its API proxy and
# its CSRF check all behave. Every image is run through this before it gets a
# tag: the e2e suite runs the dev servers, so nothing else exercises the image.
#
# Usage: smoke-test.sh <image-ref>
set -euo pipefail

IMAGE=$1

# Every PaaS injects PORT.
docker run -d --name smoke -e PORT=10000 -p 10000:10000 "$IMAGE"
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
docker rm -f smoke
