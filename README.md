# Secret — Secure, Zero-Knowledge Encrypted Note & File Sharing

[![CI/CD](https://github.com/largerio/secret/actions/workflows/deploy.yml/badge.svg)](https://github.com/largerio/secret/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-blue.svg)](https://ghcr.io/largerio/secret)

**[secret.larger.io](https://secret.larger.io)** — Share passwords, notes, and files securely with end-to-end encryption. Your data is encrypted in the browser using XChaCha20-Poly1305 — the server never sees your content. Self-hosted with a single Docker container. No accounts, no tracking, no logs.

A modern, open-source alternative to PrivateBin, OneTimeSecret, and Yopass — built with Svelte 5, Hono, and TypeScript.

## Features

- **Zero-knowledge encryption** — XChaCha20-Poly1305 (client) + AES-256-GCM (server)
- **Text & files** — Notes, documents, images, any file type. Up to 10 files per note, drag & drop.
- **Burn after read** — Destroyed after the first view
- **Password protection** — Optional, Argon2id key derivation
- **Auto-expiry** — 5 minutes to 30 days
- **Read limits** — Auto-delete after N reads
- **Delete token** — Manually delete a note at any time
- **File previews** — Images, PDF, video, audio rendered in-browser after decryption
- **Chunked uploads** — Stream large files in chunks with progress tracking (up to 500 MB)
- **S3 storage** — Optional S3-compatible backend (AWS, MinIO, R2) for large files
- **QR codes** — Share links easily on mobile
- **i18n** — 10 languages (en, fr, es, de, pt, it, ja, zh, ru, ko)
- **Self-hostable** — Single Docker container, customizable branding

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

Open `http://localhost:3000`. API documentation is available at `/api/v1/docs` ([Scalar](https://scalar.com/)).

## SDK

Use the JavaScript/TypeScript SDK to interact with any Secret instance programmatically:

```bash
npm install @secret/sdk-js
```

```typescript
import { SecretClient } from "@secret/sdk-js";

const client = await SecretClient.create({
  baseUrl: "https://secret.example.com",
  apiKey: "your-api-key",
});

// Create a note
const { id, keyFragment } = await client.createNote({ text: "Hello, World!" });
const shareUrl = client.buildShareUrl(id, keyFragment);

// Read a note from a share URL
const parsed = SecretClient.parseShareUrl(shareUrl);
const { payload } = await client.readNote(parsed.id, parsed.keyFragment);
console.log(payload.text); // "Hello, World!"
```

## How It Works

```
Browser                                  Server
┌──────────────────────┐            ┌──────────────────┐
│ 1. Generate key      │            │                  │
│ 2. Encrypt (XChaCha) │──blob──►   │ 3. Encrypt (AES) │
│                      │            │ 4. Store          │
│ URL: /note/id#key    │            │                  │
│        └─ never sent │            │ Never sees key   │
└──────────────────────┘            └──────────────────┘
```

The encryption key lives in the URL fragment (`#key`), which browsers never send to the server.

## Configuration

All settings via environment variables. See [.env.example](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_ENCRYPTION_KEY` | — | **Required.** AES-256-GCM key (32 bytes, base64) |
| `APP_NAME` | `Secret` | Application name |
| `APP_URL` | `http://localhost:3000` | Public URL |
| `APP_PRIMARY_COLOR` | `#6366f1` | Brand color |
| `MAX_FILE_SIZE` | `10485760` | Max file size in bytes (10 MB) |
| `MAX_FILES_PER_NOTE` | `10` | Max files per note |
| `MAX_EXPIRY` | `604800` | Max expiry in seconds (default: 7 days, max: 30 days) |
| `API_KEY` | — | API key for SDK clients (optional) |
| `API_KEY_1`, `API_KEY_2`… | — | Multiple API keys (optional) |
| `CHUNK_SIZE` | `4194304` | Chunk size for large uploads (4 MB) |
| `MAX_CHUNKED_FILE_SIZE` | `524288000` | Max chunked upload size (500 MB) |
| `PORT` | `3000` | Server port |

> **Warning:** Never change `SERVER_ENCRYPTION_KEY` after deployment — all existing notes become unreadable.

### S3 Storage (optional)

Files are stored locally by default. For larger files, enable S3-compatible storage:

```env
STORAGE_BACKEND=s3
S3_BUCKET=my-bucket
S3_REGION=us-east-1
S3_ENDPOINT=http://minio:9000    # MinIO / R2
S3_ACCESS_KEY_ID=your-key
S3_SECRET_ACCESS_KEY=your-secret
S3_FORCE_PATH_STYLE=true         # Required for MinIO
MAX_FILE_SIZE=104857600           # 100 MB
```

Compatible with AWS S3, MinIO, and Cloudflare R2.

## Updating

```bash
docker compose pull           # Pull new image
docker compose up -d          # Restart
docker image prune -f         # Clean up
```

Data lives in a Docker volume — updates never delete your notes.

## Reverse Proxy

**Caddy** (automatic HTTPS):
```
secret.example.com {
    reverse_proxy localhost:3000
}
```

**Nginx:**
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
        client_max_body_size 600M;
    }
}
```

Set `client_max_body_size` to match `MAX_CHUNKED_FILE_SIZE` (or `MAX_FILE_SIZE` if chunked uploads are not used).

## Development

```bash
pnpm install
pnpm dev          # API + web dev servers
pnpm test         # 422 tests, 100% backend coverage
pnpm lint         # Biome lint + format
pnpm build        # Production build
pnpm typecheck    # TypeScript strict
```

### Structure

```
apps/api/         Hono API (Node.js, SQLite, Drizzle ORM, OpenAPI)
apps/web/         SvelteKit frontend (Svelte 5, Tailwind CSS 4)
packages/sdk-js/  JS/TS SDK (SecretClient, encrypt/decrypt flows)
packages/crypto/  libsodium + AES-256-GCM encryption
packages/shared/  Zod schemas, types, constants, crypto test vectors
messages/         i18n (10 languages)
```

## Security

| Layer | Details |
|-------|---------|
| Client encryption | XChaCha20-Poly1305 (192-bit nonce, AEAD) |
| Server encryption | AES-256-GCM (defense-in-depth) |
| Password KDF | Argon2id (64 MiB, 3 iterations) |
| Write auth | PoW (Cap.js SHA-256) for browser, API keys for SDK |
| Token comparison | Timing-safe (`crypto.timingSafeEqual`) |
| Key hygiene | Zeroed after use (`sodium.memzero`) |
| Privacy | No IP logging, no cookies, no tracking |
| Database | SQLite `secure_delete`, WAL mode |
| Docker | Non-root, read-only filesystem, dropped capabilities |
| HTTP | Strict CSP, HSTS (preload), Permissions-Policy, per-IP rate limiting |
| Storage | Path traversal protection, S3 key validation |
| Validation | Zod schemas with max length constraints |

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy.

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
