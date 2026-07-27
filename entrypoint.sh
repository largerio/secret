#!/bin/sh
# Start both processes and forward termination signals to them so each can
# shut down gracefully (the API closes the SQLite handle / checkpoints WAL on
# SIGTERM). Under a plain `sh` PID 1, background children are NOT signaled on
# `docker stop`, so we trap and relay explicitly.
set -eu

term() { kill -TERM "$api_pid" "$web_pid" 2>/dev/null || true; }
trap term TERM INT

# Resolve the server encryption key so a fresh instance boots with zero config.
# Priority:
#   1. SERVER_ENCRYPTION_KEY from the environment — explicit, never written to disk.
#   2. A key previously persisted in the data volume — stable across restarts.
#   3. Otherwise generate one, persist it to the volume, and warn loudly.
# The key MUST stay stable for the life of the deployment: changing or losing it
# makes every existing note permanently undecryptable. We store it next to the
# database (inside the persistent volume) so backing up the volume backs up the key.
if [ -z "${SERVER_ENCRYPTION_KEY:-}" ]; then
	data_dir=$(dirname "${DATABASE_PATH:-/app/data/secret.db}")
	KEY_FILE="${KEY_FILE:-$data_dir/.encryption_key}"
	if [ -s "$KEY_FILE" ]; then
		SERVER_ENCRYPTION_KEY=$(cat "$KEY_FILE")
	else
		SERVER_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
		mkdir -p "$data_dir"
		# Subshell + umask so the key file is created 0600 (owner-only) atomically.
		( umask 077; printf '%s\n' "$SERVER_ENCRYPTION_KEY" > "$KEY_FILE" )
		echo "============================================================================"
		echo "No SERVER_ENCRYPTION_KEY was provided — generated one and saved it to:"
		echo "    $KEY_FILE"
		echo "This key is REQUIRED to decrypt your notes. Back up the data volume and"
		echo "NEVER change or lose it — all notes become permanently unreadable without it."
		echo "To pin it explicitly, set SERVER_ENCRYPTION_KEY in your environment."
		echo "============================================================================"
	fi
	export SERVER_ENCRYPTION_KEY
fi

# `PORT` is the public web server's, never the API's: every PaaS injects it and
# routes traffic there.
api_port="${API_PORT:-3001}"
web_port="${PORT:-3000}"

# API server: loopback only, since its one caller is the web server in this same
# container. API_HOST=0.0.0.0 exposes it.
PORT="$api_port" HOST="${API_HOST:-127.0.0.1}" node apps/api/dist/index.js &
api_pid=$!

# SvelteKit frontend (exposed). BODY_SIZE_LIMIT caps the request body the
# adapter-node server accepts; without it the adapter defaults to 512K, which
# rejects uploads. Default to ~101MB (MAX_FILE_SIZE * MAX_FILES_PER_NOTE + 1MB)
# so the image works out of the box regardless of how env vars are wired.
PORT="$web_port" ORIGIN="${APP_URL:-http://localhost:$web_port}" \
	API_URL="${API_URL:-http://127.0.0.1:$api_port}" \
	BODY_SIZE_LIMIT="${BODY_SIZE_LIMIT:-105906176}" \
	node apps/web/build/index.js &
web_pid=$!

# Exit as soon as either process exits, then signal the other and reap both.
# busybox ash has no working `wait -n` (it waits for ALL children), so poll
# instead: if one process dies the container must exit so Docker's restart
# policy and orchestrators see the failure instead of a "running" but broken
# container.
while kill -0 "$api_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
	sleep 1
done

status=0
if ! kill -0 "$api_pid" 2>/dev/null; then
	wait "$api_pid" || status=$?
else
	wait "$web_pid" || status=$?
fi
term
wait "$api_pid" "$web_pid" 2>/dev/null || true
exit "$status"
