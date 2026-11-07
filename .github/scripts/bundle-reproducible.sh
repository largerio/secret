#!/usr/bin/env bash
# Check that the web app in an image is the one a build of the same commit
# gives elsewhere, such as this runner: Ubuntu and glibc against the image's
# Alpine and musl. The digest each release publishes is only worth what anyone
# rebuilding the tag gets (SECURITY.md#verifying-the-web-app).
#
# Each side's digest is recomputed from its files, as anyone recomputes it
# (scripts/verify-web-app.sh), and must be the one its bundle.json names. On a
# difference, the two manifests are diffed: the lines that differ name the
# files. Both builds are copied into <work-dir>, image/ and runner/, and left
# there for a closer look: it must not exist yet, or be empty.
#
# Usage: bundle-reproducible.sh <image-ref> <runner-build> <work-dir>
set -euo pipefail

IMAGE=$1
RUNNER_BUILD=$2
WORK=$3
IMAGE_BUILD=/app/apps/web/build
VERIFY=$(dirname "$0")/../../scripts/verify-web-app.sh

if [ -e "$WORK" ] && { [ ! -d "$WORK" ] || [ -n "$(ls -A "$WORK")" ]; }; then
	echo "::error::$WORK is not an empty directory: the two builds go there."
	exit 1
fi
mkdir -p "$WORK"
cp -R "$RUNNER_BUILD" "$WORK/runner"

# Copied from a container that never starts.
container=$(docker create "$IMAGE")
trap 'docker rm -f "$container" > /dev/null' EXIT
if ! docker cp "$container:$IMAGE_BUILD" "$WORK/image" > /dev/null; then
	echo "::error::$IMAGE has no $IMAGE_BUILD."
	exit 1
fi

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
	computed=$("$VERIFY" --digest-of "$WORK/$side")
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
