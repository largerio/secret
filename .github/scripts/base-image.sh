#!/usr/bin/env bash
# Print the base image a Dockerfile is pinned to, as $GITHUB_OUTPUT lines:
#
#   name=node:26-alpine
#   digest=sha256:...
#
# Every stage must be pinned to the same base: the Dockerfile asks for both
# FROM lines to be bumped together, and a refresh that missed one would ship a
# mix of two bases. A stage on an unpinned image would be neither reproducible
# nor refreshed by rebuild-release.yml.
#
# Usage: base-image.sh [Dockerfile]
set -euo pipefail

DOCKERFILE=${1:-Dockerfile}

# The image of each FROM, past its flags (--platform=...), leaving out the
# stages that start from an earlier one or from scratch.
images=$(awk '
	toupper($1) == "FROM" {
		i = 2
		while ($i ~ /^--/) i++
		if (!(tolower($i) in stage) && $i != "scratch") print $i
		if (toupper($(i + 1)) == "AS") stage[tolower($(i + 2))] = 1
	}
' "$DOCKERFILE")

unpinned=$(printf '%s\n' "$images" | grep -vE '^[^@]+@sha256:[0-9a-f]{64}$' || true)
if [ -n "$unpinned" ]; then
	echo "::error file=$DOCKERFILE::FROM not pinned by digest: $(printf '%s' "$unpinned" | tr '\n' ' ')"
	exit 1
fi

pins=$(printf '%s\n' "$images" | sort -u)
if [ -z "$pins" ] || [ "$(printf '%s\n' "$pins" | wc -l)" -ne 1 ]; then
	echo "::error file=$DOCKERFILE::expected every stage on one base image, found: $(printf '%s' "${pins:-none}" | tr '\n' ' ')"
	exit 1
fi

echo "name=${pins%@*}"
echo "digest=${pins#*@}"
