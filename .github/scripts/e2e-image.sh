#!/usr/bin/env bash
# Run an image the way an operator would, on S3 storage, for the e2e suite to
# test what ships rather than the dev servers: E2E_BASE_URL=http://localhost:3000
# pnpm test:e2e. The storage is RustFS, an S3-compatible server; its image is
# not tracked by Dependabot: bump the version and the digest together.
#
# The suite's settings mirror apps/e2e/playwright.config.ts: a trivial
# proof-of-work, a raised rate limit (every test comes from one address) and
# 1 MiB chunks, so the large-file test goes chunked through S3.
#
# Usage: [E2E_PORT=<port>] e2e-image.sh <image-ref>   (port 3000 by default)
set -euo pipefail

IMAGE=$1
RUSTFS=rustfs/rustfs:1.0.3@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b
NETWORK=secret-e2e
BUCKET=secret-e2e
PORT=${E2E_PORT:-3000}
# Where the bucket is created from, off the 9000 another service may hold.
S3_HOST_PORT=19000

# Random, since written here they would read as leaked keys.
access_key=$(openssl rand -hex 12)
secret_key=$(openssl rand -hex 24)

fail() {
	echo "FAIL: $1"
	docker logs secret-e2e-app 2>&1 | tail -50 || true
	docker logs secret-e2e-s3 2>&1 | tail -20 || true
	exit 1
}

# A previous run's, when run by hand.
docker rm -f secret-e2e-app secret-e2e-s3 > /dev/null 2>&1 || true
docker network rm "$NETWORK" > /dev/null 2>&1 || true
docker network create "$NETWORK" > /dev/null

docker run -d --name secret-e2e-s3 --network "$NETWORK" -p "127.0.0.1:$S3_HOST_PORT:9000" \
	-e RUSTFS_ACCESS_KEY="$access_key" -e RUSTFS_SECRET_KEY="$secret_key" \
	"$RUSTFS" > /dev/null

# The bucket, as an operator creates it before the first start: the app checks
# it exists (readiness) but never creates it.
export AWS_ACCESS_KEY_ID=$access_key AWS_SECRET_ACCESS_KEY=$secret_key AWS_DEFAULT_REGION=us-east-1
for attempt in $(seq 30); do
	if aws --endpoint-url "http://127.0.0.1:$S3_HOST_PORT" s3api create-bucket --bucket "$BUCKET" > /dev/null 2>&1; then
		break
	fi
	[ "$attempt" -lt 30 ] || fail "RustFS never accepted the bucket"
	sleep 2
done

docker run -d --name secret-e2e-app --network "$NETWORK" -p "127.0.0.1:$PORT:$PORT" \
	-e PORT="$PORT" \
	-e APP_URL="http://localhost:$PORT" \
	-e STORAGE_BACKEND=s3 \
	-e S3_ENDPOINT=http://secret-e2e-s3:9000 \
	-e S3_BUCKET="$BUCKET" \
	-e S3_REGION=us-east-1 \
	-e S3_FORCE_PATH_STYLE=true \
	-e S3_ACCESS_KEY_ID="$access_key" \
	-e S3_SECRET_ACCESS_KEY="$secret_key" \
	-e CAP_DIFFICULTY=1 \
	-e CAP_CHALLENGE_COUNT=1 \
	-e RATE_LIMIT_MULTIPLIER=50 \
	-e CHUNK_SIZE=1048576 \
	"$IMAGE" > /dev/null

# Ready, not just up: the database and the bucket both answer.
for attempt in $(seq 30); do
	if curl -fsS "http://localhost:$PORT/api/health/ready" > /dev/null 2>&1; then
		echo "Ready on http://localhost:$PORT, storage on RustFS"
		exit 0
	fi
	[ "$attempt" -lt 30 ] || fail "the image never got ready"
	sleep 2
done
