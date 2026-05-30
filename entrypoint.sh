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

# SvelteKit frontend (exposed, port 3000)
PORT=3000 ORIGIN="${APP_URL:-http://localhost:3000}" node apps/web/build/index.js &
web_pid=$!

# Exit as soon as either process exits, then signal the other and reap both.
wait -n "$api_pid" "$web_pid"
status=$?
term
wait "$api_pid" "$web_pid" 2>/dev/null || true
exit "$status"
