#!/usr/bin/env bash
# Point tags at an image already in the registry, without rebuilding it. The
# index is copied as is, so each tag resolves to the very digest that was
# scanned and smoke-tested.
#
# With EXPECTED_CURRENT_DIGEST set, the first tag must still point at that
# digest, checked right before the tags move.
#
# Usage: promote.sh <image@sha256:...> <image:tag>...
set -euo pipefail

SOURCE=$1
shift
DIGEST=${SOURCE##*@}

# Callers pass docker/metadata-action's list, which is empty (one blank line)
# for a tag that is not semver.
refs=()
for ref in "$@"; do
	if [ -n "$ref" ]; then
		refs+=("$ref")
	fi
done
if [ "${#refs[@]}" -eq 0 ]; then
	echo "::error::no tag to promote $SOURCE to"
	exit 1
fi

digest_of() {
	docker buildx imagetools inspect "$1" --format '{{json .Manifest.Digest}}' | tr -d '"'
}

if [ -n "${EXPECTED_CURRENT_DIGEST:-}" ]; then
	current=$(digest_of "${refs[0]}")
	if [ "$current" != "$EXPECTED_CURRENT_DIGEST" ]; then
		echo "::error::${refs[0]} moved to $current in the meantime, from $EXPECTED_CURRENT_DIGEST; leaving it there."
		exit 1
	fi
fi

args=()
for ref in "${refs[@]}"; do
	args+=(--tag "$ref")
done
docker buildx imagetools create "${args[@]}" "$SOURCE"

# imagetools copies a single source index unchanged, but does not document it
# as a guarantee. A tag on any other digest would be an image nobody tested.
for ref in "${refs[@]}"; do
	got=$(digest_of "$ref")
	if [ "$got" != "$DIGEST" ]; then
		echo "::error::$ref resolves to $got, expected $DIGEST"
		exit 1
	fi
	echo "$ref -> $DIGEST"
done
