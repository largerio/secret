#!/bin/sh
# Start both processes and forward termination signals to them so each can
# shut down gracefully (the API closes the SQLite handle / checkpoints WAL on
# SIGTERM). Under a plain `sh` PID 1, background children are NOT signaled on
# `docker stop`, so we trap and relay explicitly.
set -eu

term() { kill -TERM "$api_pid" "$web_pid" 2>/dev/null || true; }
trap term TERM INT

# API server (internal, port 3001)
node apps/api/dist/index.js &
api_pid=$!

# SvelteKit frontend (exposed, port 3000). BODY_SIZE_LIMIT caps the request body
# the adapter-node server accepts; without it the adapter defaults to 512K, which
# rejects uploads. Default to ~101MB (MAX_FILE_SIZE * MAX_FILES_PER_NOTE + 1MB) so
# the image works out of the box regardless of how env vars are wired.
PORT=3000 ORIGIN="${APP_URL:-http://localhost:3000}" \
	BODY_SIZE_LIMIT="${BODY_SIZE_LIMIT:-105906176}" \
	node apps/web/build/index.js &
web_pid=$!

# Exit as soon as either process exits, then signal the other and reap both.
wait -n "$api_pid" "$web_pid"
status=$?
term
wait "$api_pid" "$web_pid" 2>/dev/null || true
exit "$status"
