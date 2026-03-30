# Secret

Zero-knowledge encrypted note and file sharing. Your data is encrypted in your browser before reaching the server — the server never sees your content.

## Features

- **Zero-knowledge encryption** — XChaCha20-Poly1305 client-side + AES-256-GCM server-side (defense-in-depth)
- **Text & file sharing** — Share notes, documents, images, and any files
- **Multi-file support** — Attach up to 10 files per note with drag & drop
- **Burn after read** — Notes destroyed after the first view
- **Password protection** — Optional Argon2id-derived password layer
- **Auto-expiry** — 5 minutes to 30 days
- **File previews** — Images, PDF, video, and audio rendered in-browser after decryption
- **QR codes** — For easy mobile sharing
- **Link preview safe** — Slack/WhatsApp bots won't trigger burn-after-read
- **Self-hostable** — Single Docker container, no external dependencies

## Quick Start

```bash
git clone https://github.com/largerio/secret.git
cd secret
cp .env.example .env

# Generate a server encryption key (REQUIRED)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Paste the output into .env as SERVER_ENCRYPTION_KEY

docker compose up -d
```

Open `http://localhost:3000` in your browser.

## How It Works

```
Client (browser)                         Server
┌──────────────────────┐            ┌──────────────────┐
│ 1. Generate key      │            │                  │
│ 2. Encrypt (XChaCha) │──blob──►   │ 3. Encrypt (AES) │
│                      │            │ 4. Store in DB   │
│ URL: /note/id#key    │            │                  │
│        └─ never sent │            │ Never sees key   │
└──────────────────────┘            └──────────────────┘
```

The encryption key lives only in the URL fragment (`#key`), which is never sent to the server by browsers.

## Configuration

All settings are in `.env`. See [.env.example](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_ENCRYPTION_KEY` | *required* | AES-256-GCM server key (32 bytes, base64) |
| `APP_NAME` | Secret | Application name in the UI |
| `APP_URL` | http://localhost:3000 | Public URL |
| `APP_PRIMARY_COLOR` | #6366f1 | Primary UI color |
| `MAX_FILE_SIZE` | 10485760 | Max file size in bytes (10MB) |
| `MAX_EXPIRY` | 604800 | Max expiry in seconds (7 days) |
| `PORT` | 3000 | Server port |

## Updating

```bash
cd /opt/secret
./scripts/backup.sh          # 1. Backup
docker compose pull           # 2. Pull new image
docker compose up -d          # 3. Restart (auto-migrations)
docker image prune -f         # 4. Clean up old images
```

Data is stored in a Docker volume — updates never delete your notes.

## Reverse Proxy

### Caddy
```
secret.example.com {
    reverse_proxy localhost:3000
}
```

### Nginx
```nginx
server {
    listen 443 ssl;
    server_name secret.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 20M;
    }
}
```

## Development

```bash
pnpm install
pnpm dev          # Start API + web in parallel
pnpm test         # Run all tests
pnpm lint         # Biome lint + format check
pnpm build        # Production build
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | SvelteKit, Tailwind CSS 4, bits-ui |
| Backend | Hono, Node.js |
| Database | SQLite (better-sqlite3 + Drizzle ORM) |
| Encryption | libsodium (XChaCha20-Poly1305 + Argon2id) |
| Serialization | MessagePack |
| Tests | Vitest |
| Linting | Biome |

## Security

- Client-side: XChaCha20-Poly1305 (192-bit nonce, AEAD)
- Server-side: AES-256-GCM (defense-in-depth)
- Key derivation: Argon2id (64 MiB, 3 iterations)
- No IP logging, no tracking cookies
- SQLite PRAGMA secure_delete enabled
- Docker: non-root user, read-only filesystem, dropped capabilities
- CSP headers enforced

## License

MIT
