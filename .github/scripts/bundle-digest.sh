#!/usr/bin/env bash
# Print the digest of the web app an image in the registry serves: the one its
# bundle.json names (packages/shared/src/bundle.ts), which /api/health reports
# and each release publishes. Every platform of the index must serve the same
# web app, since a release publishes one digest. Fails when a platform has no
# bundle.json; with --allow-none, an image none of whose platforms has one, from
# before the bundle had a digest (1.7 and older), prints nothing instead.
#
# Each platform's image is read by its own manifest digest, from a container
# that never starts: no emulation, and the index's reference is never pulled.
# Pulled once per platform, it would point at the last one pulled, and the
# classic image store refuses the second pull of a digest reference.
#
# Usage: bundle-digest.sh [--allow-none] <image-ref>
set -euo pipefail

allow_none=false
if [ "${1:-}" = --allow-none ]; then
	allow_none=true
	shift
fi
if [ "$#" -ne 1 ]; then
	echo "Usage: bundle-digest.sh [--allow-none] <image-ref>" >&2
	exit 2
fi

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
	# docker cp says why it copied nothing: no such file, or a failure of its
	# own, which must not pass for an image from before the manifest.
	if docker cp "$container:$MANIFEST" "$work/bundle.json" > /dev/null; then
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

if [ "${#found[@]}" -eq 0 ] && [ "$allow_none" = true ]; then
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
