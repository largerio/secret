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

- **`apps/api`** — Hono HTTP server (Node.js 26, TypeScript)
  - Routes: `src/routes/notes/` (split into `standard.ts`, `chunked.ts`, `openapi-routes.ts`, `helpers.ts`) — OpenAPI routes via `@hono/zod-openapi`
  - API versioned under `/api/v1/` (health endpoint stays at `/api/health`)
  - OpenAPI spec: `GET /api/v1/openapi.json`, Scalar docs: `GET /api/v1/docs`
  - Database: SQLite via Node's built-in `node:sqlite` (`DatabaseSync`) + Drizzle ORM (`drizzle-orm/node-sqlite`) (`src/db/`)
  - Storage: Abstracted backend — local filesystem or S3 (`src/storage/`)
  - Middleware: Rate limiting, security headers, CORS (`src/middleware/`)
  - Auth: PoW tokens via Cap widget for browser writes, API keys for SDK writes. Reads are open.
  - Error handling: Business logic errors use `HTTPException`, validation via `defaultHook`
  - Cleanup: Background job deletes expired notes (`src/cleanup.ts`)
  - Entry point: `src/index.ts`

- **`apps/web`** — SvelteKit 2 frontend (Svelte 5, Tailwind CSS 4)
  - Create page: `src/routes/+page.svelte`
  - View page: `src/routes/note/[id]/+page.svelte`
  - SDK client singleton: `src/lib/client.ts` — lazy-initialized `SecretClient`
  - i18n: `src/lib/i18n/index.svelte.ts` — uses `$state` rune for reactive locale
  - Runtime config: `src/lib/config.svelte.ts` — uses `$state` rune, injected via SSR (`+layout.server.ts`)

- **`packages/sdk-js`** (`@largerio/secret-sdk`) — JS/TS SDK; the **only published npm package**
  - `SecretClient` class: create, read, check, delete notes
  - Handles full encrypt→send and receive→decrypt flows
  - Progress callbacks for uploads (XHR in browser) and downloads (streaming fetch)
  - Optional API key support (`Authorization: Bearer <key>`)
  - Re-exports types from `@largerio/secret-shared`
  - Built with **tsup** (`tsup.config.ts`): bundles `crypto` + `shared` into a single
    self-contained package; `libsodium-wrappers-sumo` + `@msgpack/msgpack` stay external.
    `crypto` and `shared` are `private` (never published), but still compiled to `dist`
    via `tsc` because the API runtime imports them.

- **`packages/crypto`** — Encryption library
  - Client: XChaCha20-Poly1305 via libsodium-wrappers-sumo
  - Server: AES-256-GCM via Node.js crypto
  - Key derivation: Argon2id (password + base key)
  - Serialization: MessagePack for payloads
  - Key encoding: Base64url for URL fragments

- **`packages/shared`** — Shared types, Zod schemas, constants, test vectors
  - Request + response Zod schemas (used by OpenAPI route definitions)
  - Crypto test vectors (`src/test-vectors/vectors.json`) for cross-language SDK interoperability

## Key Design Decisions

- **Double encryption**: Client encrypts with XChaCha20-Poly1305, server re-encrypts with AES-256-GCM. Removing either layer is a security model change.
- **URL fragment for keys**: The `#key` part of URLs is never sent to the server. This is the foundation of zero-knowledge.
- **Storage abstraction**: `StorageBackend` interface with `LocalStorage` and `S3Storage` implementations. Routes never import storage directly — they use the interface from Hono context.
- **Text in DB, files on disk/S3**: Notes with `fileCount === 0` store encrypted data in SQLite. Notes with files store it on filesystem or S3 (opaque key in `filePath` column).
- **Multipart upload**: `POST /api/v1/notes/upload` accepts binary data (no base64 overhead) for large files with progress tracking.
- **API versioning**: All note and config endpoints under `/api/v1/`. OpenAPI 3.1 spec auto-generated from Zod schemas via `@hono/zod-openapi`.
- **SDK-first frontend**: The web app consumes `@largerio/secret-sdk` (dog-fooding). No direct API calls or crypto operations in the frontend.
- **Write auth**: POST and DELETE require either a PoW token (`X-Cap-Token` header, via `@cap.js/server`) or an API key (`Authorization: Bearer <key>`). Reads stay open. Cap endpoints at `/api/cap/` (internal, not documented). SDK API keys configured via `API_KEY` env var (or `API_KEY_1`, `API_KEY_2`, etc. for multiple clients).

## Code Style

- **Formatter**: Biome 2.5 — tabs, 100-char lines, double quotes, semicolons always
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

- **Node.js >= 26 is required** — run all commands (`pnpm test`, `pnpm build`, etc.)
  with Node 26+. The codebase relies on Node 26 APIs such as `Error.isError` and
  the built-in `node:sqlite` (`DatabaseSync`); older runtimes (e.g. Node 22) fail
  at runtime with errors like `Error.isError is not a function`. If the active
  shell defaults to an older Node, switch first (e.g. `nvm use 26`).
  - **AI agents (Claude Code app) running without the Docker image** land in a
    container that defaults to an older Node (e.g. Node 22) and has no Node 26
    pre-installed. Install and select it with nvm before running anything:
    ```bash
    export NVM_DIR="/opt/nvm" && . "$NVM_DIR/nvm.sh"   # nvm lives in /opt/nvm here
    nvm install 26 && nvm use 26
    pnpm install                                        # re-run so native deps build against Node 26
    ```
    Re-source nvm (`. "$NVM_DIR/nvm.sh"`) in each new shell, since env vars don't
    persist between commands.
- pnpm (workspace monorepo)
- ES modules throughout
- SQLite data in `./data/` (gitignored)

## Sensitive Files

- `.env` — Contains `SERVER_ENCRYPTION_KEY`. Never commit.
- `./data/` — SQLite database and encrypted files. Never commit.
- Server encryption key cannot be changed after deployment — all existing notes become inaccessible.

## Testing

100% coverage enforced (statements, branches, functions, lines) across the backend **and** the frontend logic modules — the gate runs in CI via `pnpm test:coverage`. Vitest runs two projects (`vitest.config.ts`): a `node` project for `packages/*` + `apps/api`, and a jsdom + Svelte `web` project (`apps/web/vitest.config.ts`) for `apps/web`.

The coverage gate (`vitest.config.ts`) only measures `.ts` sources (this also covers `*.svelte.ts` rune modules; `.svelte`/`.css` files are outside the parser). Files explicitly excluded from the gate: `**/*.d.ts`, `**/index.ts` (barrel re-exports), `**/*.test.ts` + `**/__tests__/**`, `**/types.ts` (type-only), `**/storage/interface.ts` (pure interface), and the frontend's `apps/web/src/routes/**` (loaders) + `apps/web/src/lib/server/**` (`$env`/SSR SDK) — these need a render/SvelteKit harness to exercise. So "100%" means 100% of the gated `.ts` logic, not literally every file.

Coverage scope for `apps/web/src`: logic modules and utils are gated (e.g. `lib/client.ts`, `lib/*.svelte.ts` rune stores, `lib/i18n/index.svelte.ts`, `lib/utils/*`, `hooks.server.ts`). Excluded from the gate (need a render/SvelteKit harness): `.svelte` components, `routes/**` loaders, and `lib/server/**` (`$env`/SSR SDK). End-to-end flows are covered separately by Playwright in `apps/e2e` (`pnpm test:e2e`).

Run `pnpm test` before committing. New features must include tests.

### Patterns

- API tests use Hono's `app.request()` — no HTTP server needed
- App assembly is split into testable factories: `parseConfig` (`apps/api/src/config.ts`) and `createApp` (`apps/api/src/app.ts`); `index.ts` is thin bootstrap glue
- Database tests use real SQLite (file-based, cleaned up in `beforeEach`)
- S3 tests mock `@aws-sdk/client-s3` with class-based mocks
- Crypto tests require `await initSodium()` in `beforeAll`; the test vectors in `packages/shared/src/test-vectors/vectors.json` are generated **and** consumed by the JS suite (`generate-test-vectors.test.ts`). They are structured for cross-language reuse, but there is currently no external (non-JS) implementation validating against them in CI — the "cross-language interoperability" framing is forward-looking, not an enforced guarantee.
- Frontend logic tests run under jsdom; `$state` rune modules need the `.svelte.ts` extension and the `web` Vitest project to compile
- Test files live in `__tests__/` directories alongside source
