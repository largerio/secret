# CLAUDE.md

Project context for AI assistants working on this codebase.

## What is this?

Secret is a zero-knowledge encrypted note and file sharing web application. Users encrypt data in-browser before sending it to the server. The server applies a second encryption layer (AES-256-GCM) but never sees the plaintext. The decryption key is stored in the URL fragment (`#key`) which browsers never send to the server.

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Start API + web dev servers in parallel
pnpm test             # Run all tests (vitest)
pnpm test:watch       # Run tests in watch mode
pnpm test:coverage    # Run tests with coverage (100% required)
pnpm lint             # Biome lint + format check
pnpm lint:fix         # Auto-fix lint issues
pnpm format           # Format all files
pnpm build            # Production build (all packages)
pnpm typecheck        # TypeScript strict check (all packages)
```

## Architecture

Monorepo with pnpm workspaces:

- **`apps/api`** — Hono HTTP server (Node.js 24, TypeScript)
  - Routes: `src/routes/notes.ts` (CRUD + multipart upload)
  - Database: SQLite via better-sqlite3 + Drizzle ORM (`src/db/`)
  - Storage: Abstracted backend — local filesystem or S3 (`src/storage/`)
  - Middleware: Rate limiting, security headers, CORS (`src/middleware/`)
  - Cleanup: Background job deletes expired notes (`src/cleanup.ts`)
  - Entry point: `src/index.ts`

- **`apps/web`** — SvelteKit 2 frontend (Svelte 5, Tailwind CSS 4)
  - Create page: `src/routes/+page.svelte`
  - View page: `src/routes/note/[id]/+page.svelte`
  - Crypto client: `src/lib/utils/crypto-client.ts`
  - API client: `src/lib/utils/api.ts`
  - i18n: `src/lib/i18n/index.svelte.ts` — uses `$state` rune for reactive locale
  - Runtime config: `src/lib/config.svelte.ts` — uses `$state` rune for reactive config

- **`packages/crypto`** — Encryption library
  - Client: XChaCha20-Poly1305 via libsodium-wrappers-sumo
  - Server: AES-256-GCM via Node.js crypto
  - Key derivation: Argon2id (password + base key)
  - Serialization: MessagePack for payloads
  - Key encoding: Base64url for URL fragments

- **`packages/shared`** — Shared types, Zod schemas, constants

## Key Design Decisions

- **Double encryption**: Client encrypts with XChaCha20-Poly1305, server re-encrypts with AES-256-GCM. Removing either layer is a security model change.
- **URL fragment for keys**: The `#key` part of URLs is never sent to the server. This is the foundation of zero-knowledge.
- **Storage abstraction**: `StorageBackend` interface with `LocalStorage` and `S3Storage` implementations. Routes never import storage directly — they use the interface from Hono context.
- **Text in DB, files on disk/S3**: Notes with `fileCount === 0` store encrypted data in SQLite. Notes with files store it on filesystem or S3 (opaque key in `filePath` column).
- **Multipart upload**: `POST /api/notes/upload` accepts binary data (no base64 overhead) for large files with progress tracking.

## Code Style

- **Formatter**: Biome 2.4 — tabs, 100-char lines, double quotes, semicolons always
- **TypeScript**: Strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noNonNullAssertion`)
- **No `any`**: Biome enforces `noExplicitAny`
- **Imports**: Use `type` imports for type-only (`import type { ... }`)
- **Async storage**: All `StorageBackend` methods are async (return `Promise`)
- **Error handling**: Routes return `{ error: string }` JSON — never leak internal details

## Gotchas

- **`exactOptionalPropertyTypes`**: You cannot write `salt: salt ?? undefined`. Use conditional spread instead: `...(salt ? { salt } : {})`.
- **Svelte 5 reactive modules**: Files using `$state`/`$derived` outside components must use the `.svelte.ts` extension (e.g. `config.svelte.ts`, `index.svelte.ts`).
- **Biome + Svelte**: `biome.json` has overrides for `**/*.svelte` that disable `noUnusedVariables`, `noUnusedImports`, and `organizeImports` — Biome doesn't understand Svelte template references and produces false positives.
- **Uint8Array in TS 6**: `new Blob([uint8array])` fails because `Uint8Array<ArrayBufferLike>` isn't assignable to `BlobPart`. Cast with `as BlobPart[]`.

## Environment

- Node.js >= 24
- pnpm (workspace monorepo)
- ES modules throughout
- SQLite data in `./data/` (gitignored)

## Sensitive Files

- `.env` — Contains `SERVER_ENCRYPTION_KEY`. Never commit.
- `./data/` — SQLite database and encrypted files. Never commit.
- Server encryption key cannot be changed after deployment — all existing notes become inaccessible.

## Testing

169 tests across 12 files. 100% backend coverage enforced (statements, branches, functions, lines). Frontend (`apps/web/src/`) is excluded from coverage thresholds.

Run `pnpm test` before committing. New features must include tests.

### Patterns

- API tests use Hono's `app.request()` — no HTTP server needed
- Database tests use real SQLite (file-based, cleaned up in `beforeEach`)
- S3 tests mock `@aws-sdk/client-s3` with class-based mocks
- Crypto tests require `await initSodium()` in `beforeAll`
- Test files live in `__tests__/` directories alongside source
