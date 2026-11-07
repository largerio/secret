#!/bin/sh
# Resolve the server key, then replace this shell with the app: one process,
# the API, which serves the web app and the API on PORT. Exec'd, it is the
# process Docker signals, and shuts down gracefully on its own (it closes the
# SQLite handle and checkpoints the WAL on SIGTERM).
set -eu

# Resolve the server encryption key so a fresh instance boots with zero config.
# Priority:
#   1. SERVER_ENCRYPTION_KEY, or the file SERVER_ENCRYPTION_KEY_FILE names (a
#      Docker or Kubernetes secret). The API reads either, and refuses both.
#   2. A key previously persisted in the data volume — stable across restarts.
#   3. Otherwise generate one, persist it to the volume, and warn loudly.
# The key MUST stay stable for the life of the deployment: changing or losing it
# makes every existing note permanently undecryptable. We store it next to the
# database (inside the persistent volume) so backing up the volume backs up the key.
# KEY_FILE moves it elsewhere. The API gets that file the way it gets a secret,
# as SERVER_ENCRYPTION_KEY_FILE, so no process environment holds the key.
if [ -z "${SERVER_ENCRYPTION_KEY:-}" ] && [ -z "${SERVER_ENCRYPTION_KEY_FILE:-}" ]; then
	data_dir=$(dirname "${DATABASE_PATH:-/app/data/secret.db}")
	KEY_FILE="${KEY_FILE:-$data_dir/.encryption_key}"
	if [ ! -s "$KEY_FILE" ]; then
		# Not SERVER_ENCRYPTION_KEY: compose exports it blank, and the API
		# would get the key both ways.
		key=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
		mkdir -p "$(dirname "$KEY_FILE")"
		# Subshell + umask so the key file is created 0600 (owner-only) atomically.
		( umask 077; printf '%s\n' "$key" > "$KEY_FILE" )
		unset key
		echo "============================================================================"
		echo "No SERVER_ENCRYPTION_KEY was provided — generated one and saved it to:"
		echo "    $KEY_FILE"
		echo "This key is REQUIRED to decrypt your notes. Back up the data volume and"
		echo "NEVER change or lose it — all notes become permanently unreadable without it."
		echo "To manage it yourself, set SERVER_ENCRYPTION_KEY or SERVER_ENCRYPTION_KEY_FILE."
		echo "============================================================================"
	fi
	SERVER_ENCRYPTION_KEY_FILE=$KEY_FILE
	export SERVER_ENCRYPTION_KEY_FILE
fi

# Up to 1.7, the API sat behind a web server in this container, on a port of
# its own that these set. Nothing reads them now: said rather than ignored in
# silence, since whatever used that port must move to PORT.
for name in API_PORT API_HOST API_URL; do
	if [ -n "$(printenv "$name")" ]; then
		echo "WARNING: $name is set, but no longer used: the app serves the site and the API on PORT (${PORT:-3000}) alone." >&2
	fi
done

# PORT, HOST and SHUTDOWN_TIMEOUT, unset or blank, are the API's to default
# (apps/api/src/config.ts).
exec node apps/api/dist/index.js
