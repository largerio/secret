#!/usr/bin/env bash
# Print, as $GITHUB_OUTPUT lines, whether HEAD is a release commit and the
# version an image built from it reports (apps/api/src/buildInfo.ts):
#
#   release=true
#   version=1.4.2
#
# The version is the first release heading of CHANGELOG.md. The release
# commit is the one that puts it at the top; any later commit reports it
# suffixed -dev. HEAD's parent must be fetched (fetch-depth: 2 or more).
#
# Usage: changelog-release.sh
set -euo pipefail

# Reads to the end: stopping at the first match could leave git show writing
# to a closed pipe, and pipefail would take that for no parent.
latest() {
	awk '!found && /^## \[[0-9]+\.[0-9]+\.[0-9]+/ { sub(/^## \[/, ""); sub(/\].*/, ""); print; found = 1 }'
}

current=$(git show HEAD:CHANGELOG.md | latest)
previous=$(git show HEAD^:CHANGELOG.md 2> /dev/null | latest) || previous=""

if [ -n "$current" ] && [ "$current" != "$previous" ]; then
	echo "release=true"
	echo "version=$current"
else
	echo "release=false"
	echo "version=${current:+$current-dev}"
fi
