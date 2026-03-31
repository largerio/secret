# Secret

Zero-knowledge encrypted note and file sharing. Your data is encrypted in your browser before reaching the server — the server never sees your content.

## Features

- **Zero-knowledge encryption** — XChaCha20-Poly1305 client-side + AES-256-GCM server-side (defense-in-depth)
- **Text & file sharing** — Share notes, documents, images, and any files
- **Multi-file support** — Attach up to 10 files per note with drag & drop
- **Burn after read** — Notes destroyed after the first view
- **Password protection** — Optional Argon2id-derived password layer
- **Auto-expiry** — 5 minutes to 30 days
- **Read limits** — Set a maximum number of reads before auto-deletion
- **File previews** — Images, PDF, video, and audio rendered in-browser after decryption
- **QR codes** — For easy mobile sharing
- **S3 storage** — Optional S3-compatible backend (AWS, MinIO, R2) for large files
- **Progress indicators** — Upload and download progress bars for large files
- **Link preview safe** — Slack/WhatsApp bots won't trigger burn-after-read
- **i18n** — English and French
- **Self-hostable** — Single Docker container, fully customizable branding

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
| `MAX_FILE_SIZE` | 10485760 | Max file size in bytes (10 MB) |
| `MAX_FILES_PER_NOTE` | 10 | Max files per note |
| `MAX_EXPIRY` | 604800 | Max expiry in seconds (7 days) |
| `PORT` | 3000 | Server port |

### S3 Storage (optional)

By default, files are stored on the local filesystem. To enable S3-compatible storage for larger files:

```env
STORAGE_BACKEND=s3
S3_BUCKET=my-bucket
S3_REGION=us-east-1
S3_ENDPOINT=http://minio:9000    # For MinIO/R2
S3_ACCESS_KEY_ID=your-key
S3_SECRET_ACCESS_KEY=your-secret
S3_FORCE_PATH_STYLE=true         # Required for MinIO
MAX_FILE_SIZE=104857600           # 100 MB
```

Works with AWS S3, MinIO, Cloudflare R2, and any S3-compatible provider.

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
        client_max_body_size 120M;
    }
}
```

Adjust `client_max_body_size` to match your `MAX_FILE_SIZE` setting.

## Development

```bash
pnpm install
pnpm dev          # Start API + web in parallel
pnpm test         # Run all tests (154 tests)
pnpm lint         # Biome lint + format check
pnpm build        # Production build
pnpm typecheck    # TypeScript strict check
```

### Project Structure

```
secret/
├── apps/
│   ├── api/              Hono API server (Node.js, SQLite)
│   │   └── src/
│   │       ├── routes/       API endpoints
│   │       ├── db/           Drizzle ORM schema + migrations
│   │       ├── storage/      Storage abstraction (local/S3)
│   │       ├── middleware/   Rate limiting, security headers, CORS
│   │       └── __tests__/    API tests
│   └── web/              SvelteKit frontend
│       └── src/
│           ├── routes/       Pages (create, view note)
│           └── lib/          Components, utils, i18n, config
├── packages/
│   ├── crypto/           libsodium wrapper, MessagePack serialization
│   └── shared/           Zod schemas, types, constants
├── messages/             i18n translations (en.json, fr.json)
├── Dockerfile            Multi-stage production build
├── docker-compose.yml    Single service deployment
└── .env.example          Configuration template
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | SvelteKit 2, Svelte 5, Tailwind CSS 4 |
| Backend | Hono 4, Node.js 22 |
| Database | SQLite (better-sqlite3 + Drizzle ORM) |
| Storage | Local filesystem or S3-compatible |
| Encryption | libsodium (XChaCha20-Poly1305 + Argon2id) |
| Server encryption | Node.js crypto (AES-256-GCM) |
| Serialization | MessagePack |
| Validation | Zod |
| Tests | Vitest (154 tests) |
| Linting | Biome |

## Security

- **Client-side**: XChaCha20-Poly1305 (192-bit nonce, AEAD)
- **Server-side**: AES-256-GCM (defense-in-depth)
- **Key derivation**: Argon2id (64 MiB, 3 iterations)
- **Delete tokens**: Timing-safe comparison (crypto.timingSafeEqual)
- **Memory**: Sensitive keys zeroed after use (sodium.memzero)
- **No tracking**: No IP logging, no cookies
- **Database**: SQLite PRAGMA secure_delete, WAL mode
- **Docker**: Non-root user, read-only filesystem, dropped capabilities
- **CSP**: Strict Content Security Policy headers
- **Rate limiting**: Per-IP with configurable windows
- **Input validation**: Zod schemas with max length constraints

## License

[MIT](LICENSE)
