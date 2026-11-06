#!/usr/bin/env bash
# Print the digest of the web app an image in the registry serves: the one its
# bundle.json names (packages/shared/src/bundle.ts), which /api/health reports
# and each release publishes. Every platform of the index must serve the same
# web app, since a release publishes one digest. Prints nothing for an image
# from before the bundle had one (1.7 and older); fails when only some of its
# platforms have one.
#
# Read from containers that never start: an image of any platform will do.
#
# Usage: bundle-digest.sh <image-ref>
set -euo pipefail

IMAGE=$1
MANIFEST=/app/apps/web/build/bundle.json

work=$(mktemp -d)
container=""
trap '[ -z "$container" ] || docker rm -f "$container" > /dev/null; rm -rf "$work"' EXIT

# The platforms of the index, its attestations left out. A single image has
# none, and is read as it is.
platforms=$(docker buildx imagetools inspect --raw "$IMAGE" | jq -r '
	[.manifests[]?.platform | select(. != null and .os != "unknown")
		| [.os, .architecture, .variant // empty] | join("/")] | unique | .[]')

found=()
missing=()
for platform in ${platforms:-default}; do
	# Pulled each time: an image already there for another platform would
	# otherwise do.
	args=(--pull always)
	if [ "$platform" != default ]; then
		args+=(--platform "$platform")
	fi
	container=$(docker create "${args[@]}" "$IMAGE")
	if docker cp "$container:$MANIFEST" "$work/bundle.json" > /dev/null 2>&1; then
		digest=$(jq -r .digest "$work/bundle.json")
		if ! [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]]; then
			echo "::error::$MANIFEST on $platform names the digest $digest" >&2
			exit 1
		fi
		found+=("$platform $digest")
	else
		missing+=("$platform")
	fi
	rm -f "$work/bundle.json"
	docker rm "$container" > /dev/null
	container=""
done

if [ "${#found[@]}" -eq 0 ]; then
	exit 0
fi
if [ "${#missing[@]}" -gt 0 ]; then
	echo "::error::$IMAGE has no $MANIFEST on ${missing[*]}" >&2
	exit 1
fi

digests=$(printf '%s\n' "${found[@]}" | cut -d' ' -f2 | sort -u)
if [ "$(wc -l <<< "$digests")" -ne 1 ]; then
	joined=$(IFS=,; echo "${found[*]}")
	echo "::error::The platforms of $IMAGE serve different web apps: ${joined//,/, }" >&2
	exit 1
fi
echo "$digests"
