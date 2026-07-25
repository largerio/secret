# Secret — Secure, Zero-Knowledge Encrypted Note & File Sharing

[![CI/CD](https://github.com/largerio/secret/actions/workflows/deploy.yml/badge.svg)](https://github.com/largerio/secret/actions/workflows/deploy.yml)
[![Coverage](https://img.shields.io/badge/coverage-100%25%20enforced-brightgreen.svg)](vitest.config.ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/largerio/secret?style=flat&color=blue)](https://github.com/largerio/secret/stargazers)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-blue.svg)](https://ghcr.io/largerio/secret)
[![npm](https://img.shields.io/npm/v/@largerio/secret-sdk?color=blue&label=%40largerio%2Fsecret-sdk)](https://www.npmjs.com/package/@largerio/secret-sdk)

Share passwords, notes, and files securely with end-to-end encryption. Your data is encrypted in the browser using XChaCha20-Poly1305 — **the server never sees your content.** Self-hosted with a single Docker container. No accounts, no tracking, no logs.

A modern, open-source alternative to PrivateBin, OneTimeSecret, and Yopass — built with Svelte 5, Hono, and TypeScript.

**[🔗 Live demo](https://secret.larger.io)** &nbsp;·&nbsp; [Quick Start](#quick-start) &nbsp;·&nbsp; [Self-Hosting](docs/self-hosting.md) &nbsp;·&nbsp; [SDK](#sdk) &nbsp;·&nbsp; [Security](SECURITY.md)

<p align="center">
  <img src="docs/images/demo.gif" alt="Compose a secret, encrypt it in the browser, and get a one-time share link whose key never reaches the server" width="100%" />
</p>

<p align="center">
  <img src="docs/images/create.png" alt="Compose a note — encrypted in your browser before it is ever sent" width="32%" />
  &nbsp;
  <img src="docs/images/share.png" alt="Get a one-time link — the decryption key lives in the URL and never reaches the server" width="32%" />
  &nbsp;
  <img src="docs/images/view.png" alt="Recipient opens the link — decrypted locally, self-destructs after reading" width="32%" />
</p>

<p align="center"><sub><b>Create</b> → encrypted locally &nbsp;·&nbsp; <b>Share</b> → one-time link, key never sent &nbsp;·&nbsp; <b>Read</b> → decrypted in-browser, then gone</sub></p>

## Table of Contents

- [Features](#features)
- [Comparison](#comparison)
- [Quick Start](#quick-start)
- [SDK](#sdk)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
  - [S3 Storage (optional)](#s3-storage-optional)
- [Self-Hosting (Synology, VPS, backups)](#self-hosting)
- [Updating](#updating)
- [Reverse Proxy](#reverse-proxy)
- [Development](#development)
- [Security](#security)
- [License](#license)
- [Contributing](#contributing)

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
- **i18n** — 10 languages (en, fr, es, de, pt, it, ja, zh, ru, ko); [adding one](CONTRIBUTING.md#i18n) is a JSON file in [`messages/`](messages/) plus three registration lines
- **Self-hostable** — Single Docker container, customizable branding

## Comparison

| Feature                | Secret              | PrivateBin          | OneTimeSecret       | Yopass              |
|------------------------|---------------------|---------------------|---------------------|---------------------|
| Zero-knowledge         | Yes                 | Yes                 | No (server-side)    | Yes                 |
| Client cipher          | XChaCha20-Poly1305  | AES-256-GCM         | —                   | OpenPGP             |
| Server-side encryption | Yes (AES-256-GCM)   | No                  | Yes                 | No                  |
| File attachments       | Up to 10, 500 MB    | Single, opt-in      | No                  | Single, streaming   |
| File previews          | Image/PDF/AV        | Image/PDF/media     | No                  | No                  |
| Burn after read        | Yes                 | Yes                 | Yes                 | Yes (toggleable)    |
| Read limits (N reads)  | Yes                 | No                  | No                  | No                  |
| Password protection    | Yes (Argon2id)      | Yes (PBKDF2)        | Yes (passphrase)    | Yes                 |
| Official SDK           | Yes (JS/TS)         | No                  | REST API only       | CLI only            |
| Stack                  | Svelte 5 + Hono     | PHP                 | Ruby                | Go + React          |
| Deploy                 | Single Docker       | PHP server          | Ruby + Redis        | Single Docker       |

> Comparison reflects publicly documented features at the time of writing. See each project's docs for the latest details.

## Quick Start

**Fastest — prebuilt image (no clone, no build):**

```bash
mkdir secret && cd secret
curl -O https://raw.githubusercontent.com/largerio/secret/main/docker-compose.yml

docker compose up -d      # pulls ghcr.io/largerio/secret:latest
```

That's it — on first launch the server encryption key is generated automatically and
saved inside the data volume, so there's nothing to configure. For a real deployment
on your own domain, add a `.env` to set your public URL (and optionally pin the key):

```bash
curl -o .env https://raw.githubusercontent.com/largerio/secret/main/.env.example
# In .env, set:
#   APP_URL=https://secret.example.com    # your public URL (used for CORS, sitemap, robots.txt)
# Optional — pin the key yourself instead of the auto-generated one:
#   openssl rand -base64 32   → SERVER_ENCRYPTION_KEY=<output>
docker compose up -d --force-recreate
```

Open `http://localhost:3000`. API documentation is available at `/api/v1/docs` ([Scalar](https://scalar.com/)).
If something doesn't work, run `docker compose logs -f` — see
[Troubleshooting](docs/self-hosting.md#troubleshooting).

**One-click / platform deploys:**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/largerio/secret)

| Platform | How |
|----------|-----|
| **Render** | Click the button above ([guide](docs/self-hosting.md#railway--render-paas)) |
| **Coolify** | New Resource → Docker Image → `ghcr.io/largerio/secret:latest` ([guide](docs/self-hosting.md#coolify)) |
| **Portainer** | Stacks → paste `docker-compose.yml` ([guide](docs/self-hosting.md#portainer)) |
| **Synology NAS** | Container Manager project ([guide](docs/self-hosting.md#synology-nas-dsm-7--container-manager)) |

**From source (for contributors):**

```bash
git clone https://github.com/largerio/secret.git
cd secret
cp .env.example .env   # optional — set APP_URL / pin SERVER_ENCRYPTION_KEY if you want

# Uncomment `build: .` (and comment out `image:`) in docker-compose.yml to build locally
docker compose up -d
```

For Synology NAS, VPS, reverse proxy, troubleshooting and backup instructions, see the
[Self-Hosting guide](docs/self-hosting.md).

## SDK

Use the JavaScript/TypeScript SDK to interact with any Secret instance programmatically:

```bash
npm install @largerio/secret-sdk
```

```typescript
import { SecretClient } from "@largerio/secret-sdk";

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
Browser                                   Server
┌──────────────────────┐             ┌──────────────────┐
│ 1. Generate key      │             │                  │
│ 2. Encrypt (XChaCha) │──ciphertext►│ 3. Encrypt (AES) │
│                      │             │ 4. Store         │
│ URL: /note/id#key    │             │                  │
│        └─ never sent │             │ Never sees key   │
└──────────────────────┘             └──────────────────┘
```

The encryption key lives in the URL fragment (`#key`), which browsers never send to the server.

## Configuration

All settings via environment variables. See [.env.example](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_ENCRYPTION_KEY` | _auto_ | AES-256-GCM key (32 bytes, base64). Auto-generated and persisted in the data volume on first launch if unset; set it explicitly to control/back up the key yourself |
| `APP_NAME` | `Secret` | Application name |
| `APP_URL` | `http://localhost:3000` | Public URL |
| `APP_PRIMARY_COLOR` | `#6366f1` | Brand color (see `.env.example` for footer and social image) |
| `MAX_FILE_SIZE` | `10485760` | Max file size in bytes (10 MB) |
| `MAX_FILES_PER_NOTE` | `10` | Max files per note (cannot exceed 10) |
| `MAX_EXPIRY` | `2592000` | Retention ceiling in seconds (30 days). Can only be tightened; minimum 300 |
| `API_KEY` | — | API key for SDK clients, min. 32 chars (optional) |
| `API_KEY_1`, `API_KEY_2`… | — | Multiple API keys (optional) |
| `ALLOW_SERVER_KEY_CHANGE` | `false` | Allow booting with a different `SERVER_ENCRYPTION_KEY`, discarding every existing note |
| `RATE_LIMIT_MULTIPLIER` | `1` | Scales every per-IP rate limit. Raise it when many legitimate users share one apparent address (corporate NAT, VPN) |
| `CHUNK_SIZE` | `4194304` | Chunk size for large uploads (4 MB) |
| `MAX_CHUNKED_FILE_SIZE` | `524288000` | Max chunked upload size (500 MB) |
| `PORT` | `3000` | Host port the app is published on (inside the container the web server always listens on 3000, the API on 3001) |

> **Warning:** Never change `SERVER_ENCRYPTION_KEY` after deployment — all existing notes become unreadable. The server stores a fingerprint of the key and **refuses to start** if it changes while notes exist, so a mistake fails loudly instead of silently bricking your data. When the key is auto-generated it lives at `.encryption_key` inside the data volume, so backing up the volume backs up the key; read it back with `docker compose exec app cat /app/data/.encryption_key`.

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

## Self-Hosting

Step-by-step deployment guides for common setups are in
**[docs/self-hosting.md](docs/self-hosting.md)**:

- **VPS / any Docker host** — two-file deploy (`docker-compose.yml` + `.env`), no clone
- **Synology NAS** — DSM Container Manager walkthrough, with volume/permission notes
- **Reverse proxy & HTTPS** — including DSM's built-in reverse proxy
- **Backup & restore** — snapshotting the `secret-data` volume safely

## Updating

```bash
docker compose pull           # Pull new image
docker compose up -d          # Restart
docker image prune -f         # Clean up
```

Data lives in a Docker volume — updates never delete your notes.

### Pinning a version

`docker-compose.yml` tracks `:latest` (the tip of `main`). For reproducible
deploys, pin a published release tag on the `image:` line instead:

| Image tag | Tracks |
|-----------|--------|
| `ghcr.io/largerio/secret:latest` | tip of `main` (newest, may include unreleased changes) |
| `ghcr.io/largerio/secret:1.0` | latest `1.0.x` patch — **recommended**, gets fixes without breaking changes |
| `ghcr.io/largerio/secret:1.0.0` | that exact release, fully reproducible |

After changing the tag, run `docker compose pull && docker compose up -d`. The
[Releases](https://github.com/largerio/secret/releases) page doubles as the
changelog — read it (especially any **Upgrade notes**) before moving to a new
major version.

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

Set `client_max_body_size` to at least `MAX_CHUNKED_FILE_SIZE` (or `MAX_FILE_SIZE` if chunked uploads are not used). The example uses 600M as a safety margin above the 500 MB default.

## Development

```bash
pnpm install
pnpm dev          # API + web dev servers
pnpm test         # full suite
pnpm test:coverage # same, with the 100% coverage gate (what CI runs)
pnpm lint         # Biome lint + format
pnpm build        # Production build
pnpm typecheck    # TypeScript strict
```

### Structure

```
apps/api/         Hono API (Node.js, SQLite, Drizzle ORM, OpenAPI)
apps/web/         SvelteKit frontend (Svelte 5, Tailwind CSS 4)
apps/e2e/         Playwright end-to-end tests (incl. axe-core a11y gate)
packages/sdk-js/  JS/TS SDK (SecretClient, encrypt/decrypt flows)
packages/crypto/  libsodium + AES-256-GCM encryption
packages/shared/  Zod schemas, types, constants, crypto test vectors
messages/         i18n (10 languages)
```

> Requires **Node.js 26+** (the code uses Node 26 APIs such as `Error.isError`
> and the built-in `node:sqlite`). Use `nvm use 26` if your shell defaults to an
> older version.

### Publishing the SDK

Only **`@largerio/secret-sdk`** is published to npm. Its build (tsup) bundles the
internal `@largerio/secret-crypto` and `@largerio/secret-shared` packages, which
stay private — so consumers install a single self-contained package. Releases go
through [changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset          # describe the change + pick the version bump
pnpm version-packages   # apply pending changesets (bump version + changelog)
pnpm release            # build (bundles internals), then publish to npm
```

In development everything resolves to TypeScript sources (`exports` → `./src`);
the bundled `dist/` is produced only when the SDK is packed/published.

CI publishes via **npm trusted publishing (OIDC)** — see
[`.github/workflows/release.yml`](.github/workflows/release.yml). Merging a
changeset to `main` opens a "Version Packages" PR; merging that PR publishes the
new version. No `NPM_TOKEN` secret is used: GitHub authenticates to npm with a
short-lived OIDC token against the package's configured trusted publisher.

## Security

| Layer | Details |
|-------|---------|
| Client encryption | XChaCha20-Poly1305 (192-bit nonce, AEAD) |
| Server encryption | AES-256-GCM (defense-in-depth) |
| Password KDF | Argon2id (256 MiB, 3 iterations — libsodium `MODERATE`) |
| Write auth | PoW (Cap.js SHA-256) for browser, API keys for SDK |
| Token comparison | Timing-safe (`crypto.timingSafeEqual`) |
| Key hygiene | Cleared from the WASM heap after use (`sodium.memzero`). The key still lives in the URL, browser history and clipboard — that is inherent to the link-carries-the-key model. |
| Privacy | No IP logging, no tracking. Two first-party preference cookies (language, theme). |
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
