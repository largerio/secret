#!/usr/bin/env bash
# Print the digest of the web app an image in the registry serves: the one its
# bundle.json names (packages/shared/src/bundle.ts), which /api/health reports
# and each release publishes. Every platform of the index must serve the same
# web app, since a release publishes one digest. Prints nothing for an image
# from before the bundle had one (1.7 and older); fails when only some of its
# platforms have one.
#
# Each platform's image is read by its own manifest digest, from a container
# that never starts: no emulation, and the index's reference is never pulled.
# Pulled once per platform, it would point at the last one pulled, and the
# classic image store refuses the second pull of a digest reference.
#
# Usage: bundle-digest.sh <image-ref>
set -euo pipefail

IMAGE=$1
MANIFEST=/app/apps/web/build/bundle.json

# The repository, without the tag or digest: the part after the last slash
# holds the tag, so a registry's port stays.
repo=${IMAGE%%@*}
if [[ ${repo##*/} == *:* ]]; then
	repo=${repo%:*}
fi

work=$(mktemp -d)
container=""
trap '[ -z "$container" ] || docker rm -f "$container" > /dev/null; rm -rf "$work"' EXIT

# `<platform> <manifest digest>` a line, the attestations left out. A single
# image is its own manifest.
raw=$(docker buildx imagetools inspect --raw "$IMAGE")
images=$(jq -r '.manifests[]? | select(.platform != null and .platform.os != "unknown")
	| "\([.platform.os, .platform.architecture, .platform.variant // empty] | join("/")) \(.digest)"' <<< "$raw")
if [ -z "$images" ]; then
	images="default $(docker buildx imagetools inspect "$IMAGE" --format '{{json .Manifest.Digest}}' | tr -d '"')"
fi

found=()
missing=()
while read -r platform digest; do
	args=()
	if [ "$platform" != default ]; then
		args=(--platform "$platform")
	fi
	container=$(docker create ${args[@]+"${args[@]}"} "$repo@$digest" < /dev/null)
	if docker cp "$container:$MANIFEST" "$work/bundle.json" > /dev/null 2>&1; then
		bundle=$(jq -r .digest "$work/bundle.json")
		if ! [[ $bundle =~ ^sha256:[0-9a-f]{64}$ ]]; then
			echo "::error::$MANIFEST on $platform names the digest $bundle" >&2
			exit 1
		fi
		found+=("$platform $bundle")
	else
		missing+=("$platform")
	fi
	rm -f "$work/bundle.json"
	docker rm "$container" > /dev/null
	container=""
done <<< "$images"

if [ "${#found[@]}" -eq 0 ]; then
	exit 0
fi
if [ "${#missing[@]}" -gt 0 ]; then
	echo "::error::$IMAGE has no $MANIFEST on ${missing[*]}" >&2
	exit 1
fi

bundles=$(printf '%s\n' "${found[@]}" | cut -d' ' -f2 | sort -u)
if [ "$(wc -l <<< "$bundles")" -ne 1 ]; then
	joined=$(IFS=,; echo "${found[*]}")
	echo "::error::The platforms of $IMAGE serve different web apps: ${joined//,/, }" >&2
	exit 1
fi
echo "$bundles"
