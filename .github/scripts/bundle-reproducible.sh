#!/usr/bin/env bash
# Check that the web app in an image is the one a build of the same commit
# gives elsewhere, such as this runner: Ubuntu and glibc against the image's
# Alpine and musl. The digest each release publishes is only worth what anyone
# rebuilding the tag gets (SECURITY.md#verifying-the-web-app).
#
# Each side's digest is recomputed from its files with coreutils, as
# packages/shared/src/bundle.ts specifies, and must be the one its bundle.json
# names. On a difference, the two manifests are diffed: the lines that differ
# name the files. Both builds are left in <work-dir>, image/ and runner/, for a
# closer look.
#
# Usage: bundle-reproducible.sh <image-ref> <build-dir> <work-dir>
set -euo pipefail

IMAGE=$1
BUILD=$2
WORK=$3
BUNDLE=/app/apps/web/build

rm -rf "$WORK"
mkdir -p "$WORK"
cp -R "$BUILD" "$WORK/runner"

# Copied from a container that never starts.
container=$(docker create "$IMAGE")
trap 'docker rm -f "$container" > /dev/null' EXIT
if ! docker cp "$container:$BUNDLE" "$WORK/image" > /dev/null; then
	echo "::error::$IMAGE has no $BUNDLE."
	exit 1
fi

# The listing the digest hashes: `<sha256>  <path>` a line, sorted by byte,
# the manifest left out.
listing() {
	(cd "$1" && find . -type f ! -path ./bundle.json -printf '%P\n' | LC_ALL=C sort \
		| xargs -r -d '\n' sha256sum)
}

# The manifest's files a line each, path first so that diff lines them up.
files() {
	jq -r '.files[] | "\(.path)  \(.size)  \(.sha256)"' "$1/bundle.json"
}

declare -A digest
for side in image runner; do
	if [ ! -f "$WORK/$side/bundle.json" ]; then
		echo "::error::The $side's build of the web app has no bundle.json."
		exit 1
	fi
	computed="sha256:$(listing "$WORK/$side" | sha256sum | cut -d' ' -f1)"
	named=$(jq -r .digest "$WORK/$side/bundle.json")
	if [ "$computed" != "$named" ]; then
		echo "::error::The $side's bundle.json names $named, its files make $computed."
		exit 1
	fi
	digest[$side]=$computed
done

if [ "${digest[image]}" != "${digest[runner]}" ]; then
	echo "::error::The web app in $IMAGE is ${digest[image]}, the same commit built on this runner ${digest[runner]}: the build is not reproducible."
	diff -u --label image/bundle.json --label runner/bundle.json \
		<(files "$WORK/image") <(files "$WORK/runner") || true
	exit 1
fi

echo "The web app in $IMAGE is ${digest[image]}, as built on this runner."
