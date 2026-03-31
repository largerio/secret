#!/bin/sh
# Start API server (internal, port 3001)
node apps/api/dist/index.js &

# Start SvelteKit frontend (exposed, port 3000)
PORT=3000 ORIGIN="${APP_URL:-http://localhost:3000}" node apps/web/build/index.js
