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
  - Notes: `src/notes/` holds the rules, with no HTTP in them. It imports the infrastructure (db, storage, quota, pending deletions), which never imports it; the routes and the cleanup job do:
    - `service.ts`: `createNotesService` (create, check, read, stream, readWithProofs, delete, and the upload sessions of `uploads.ts`) — what spends a read, what burns a note, when its storage is purged. `read`/`stream` serve format 0 only; `readWithProofs` serves format 1, once the link proof and, for a password note, the password proof check out (`checkProofs`), always as framed messages: a note sent in one request is kept single-shot and served as its one message (`serveSingleShot`), one sent in a session chunk by chunk (`serveChunked`)
    - `rows.ts`: note rows — the one place a row is built (`newNoteRow`), where a note is stored (`placementOf`, `singleShotPlacement`: text stays in SQLite), the one definition of a chunked note (`isChunked`) and of a format 1 note (`isFormat1`: its row has an envelope or a verifier, so a row that lost its envelope fails closed), how a reader opens a row (`openingOf`/`chunkedOpeningOf` for format 0, `format1ReadingOf` for format 1: its opening and sealed verifiers, or undefined for a corrupt row), `lookUpNote`, `spendRead`, `takePasswordAttempt`/`settlePasswordAttempt` (an attempt is counted before the proof is compared, given back when it matches; the fifth wrong password deletes the note), `removeNote` (row deleted, purge queued in the same transaction)
    - `formats.ts`: what a write declares in either format, as the service's `NoteSettings` (`settingsOf`, `chunkedSettingsOf`: format 1's from its envelope, kept byte for byte, with the writer's verifiers; `sessionSettingsOf` for an upload session, its verifiers already sealed)
    - `serverLayer.ts`: the server's AES-256-GCM layer, built once with the key, in its two layouts (IV in the row for single-shot notes, IV in front of each chunk), and the sealing of format 1 verifiers (HMAC-SHA256 over the verifier's role, the note id and the envelope's hash, under a key derived from the instance key; `proves` checks a reader's proof against one)
    - `padding.ts`: `assertPadded`, the lengths a format 1 note's messages may have (every one before the last as long as the first, the last no longer, the body they hold a size class), checked when a note is sent in one request and at a session's completion, from its chunks' sealed sizes less `SEALED_CHUNK_OVERHEAD`
    - `stream.ts` (a chunked note's chunks with read-ahead and backpressure, and a note sent whole as one chunk), `limits.ts` (the operator's limits and the quota), `errors.ts` (`NoteError`, its codes and their one message each), `types.ts`
  - Routes: `src/routes/notes/` (`writes.ts`, `reads.ts`) are thin: every route goes through `app.openapi`, so its schema in `openapi-routes.ts` validates the request and documents it; the handler calls the service and shapes the answer (`responses.ts`, including the stream's length-prefix framing). `errorStatus.ts` maps every `NoteError` code to a status: the one place a refusal becomes HTTP
  - API versioned under `/api/v1/` (health endpoint stays at `/api/health`)
  - OpenAPI spec: `GET /api/v1/openapi.json`, Scalar docs: `GET /api/v1/docs`
  - Database: SQLite via Node's built-in `node:sqlite` (`DatabaseSync`) + Drizzle ORM (`drizzle-orm/node-sqlite`) (`src/db/`)
  - Migrations: versioned via `PRAGMA user_version`, applied at boot (`src/db/migrations.ts`); a downgrade (DB newer than the build) refuses to start. Schema changes: edit `schema.ts`, run `pnpm db:generate` (drizzle-kit) in `apps/api`, embed the emitted SQL as a new `MIGRATIONS` entry
  - Storage: Abstracted backend — local filesystem or S3 (`src/storage/`)
  - Middleware: Rate limiting, security headers, CORS (`src/middleware/`)
  - Auth: PoW tokens via Cap widget for browser writes, API keys for SDK writes, attached per route (`middleware` of the write routes in `routes/notes/writes.ts`, before validation). Reads need none: a format 1 read proves the link instead
  - Error handling: every error answers problem details (RFC 9457, `application/problem+json`) through `src/middleware/problem.ts`: `code` (stable, the client's to branch on, listed in PROTOCOL.md "Errors"), `detail`, and `error` repeating it for older clients. The notes service refuses with `NoteError`, whose code the app's error handler answers through `routes/notes/errorStatus.ts` (its `toHttpException` option, a `ProblemException`); request validation goes through the route schemas and `defaultHook`; middlewares answer with `problem()`. A 500 is logged with an `errorId`, returned to the client; a refusal (4xx, or 507 for a full instance) is not logged
  - Logging: structured JSON lines (`src/logger.ts`, zero-dependency); per-request `X-Request-Id` + request log middleware (`src/middleware/requestContext.ts`). Logs record route *patterns*, never raw paths (note ids stay out of logs); 500s carry `errorId` + `requestId` for correlation
  - Cleanup: Background job deletes expired notes (`src/cleanup.ts`). Storage purges go through the `pending_deletions` outbox (`src/pendingDeletions.ts`): enqueued in the transaction that deletes the row, run after commit, retried by the job. A daily sweep (`src/reconcile.ts`) purges stored objects no row points to, only on storage no other database has claimed
  - Health and metrics: `/api/health/live` (process up), `/api/health/ready` (database + storage, `503` once shutdown starts), `/api/health` (readiness plus version and revision, from `src/buildInfo.ts`). `/api/metrics` (Prometheus text, `src/metrics.ts` + `src/prometheus.ts`, zero-dependency) exists only when `METRICS_TOKEN` is set; labels hold route patterns and bounded values, never note ids
  - Secrets: each one can come from `NAME_FILE` instead of `NAME` (`readSecret` in `src/config.ts`); `entrypoint.sh` keeps the API's secrets and their `_FILE` variables out of the web process
  - Backup: `node apps/api/dist/backup.js <destination>` (`src/db/backup.ts`) takes a hot copy with `VACUUM INTO`
  - Entry points: `src/index.ts` (server), `src/backup.ts` (backup command)

- **`apps/web`** — SvelteKit 3 frontend (Svelte 5, Tailwind CSS 4)
  - Config (adapter-node, CSP): the `sveltekit({...})` plugin in `vite.config.ts` — SvelteKit 3 refuses a `svelte.config.js`
  - Server env vars: declared in `src/env.ts` (`defineEnvVars`), read from `$app/env/private` — undeclared variables are invisible to the app
  - Create page: `src/routes/+page.svelte`
  - View page: `src/routes/note/[id]/+page.svelte`
  - Notes in a worker: `src/lib/notes/` — the SDK runs only in a module worker (`notes.worker.ts`, its entry; `worker.ts` answers the page's requests), so Argon2id and the ciphers stay off the page's thread and no page loads libsodium. Pages call `notes.ts` (`createNote`, `readNote`, `checkNote`, `deleteNote`); `protocol.ts` carries requests, progress and errors (re-created of their SDK class on the page). A read decrypts its files into the origin private file system (`staging.ts`, a directory per read, memory where that is missing or short of room), held by a Web Lock while the page shows the note: closing the note deletes them, and `sweepStaged` (on every page's mount) deletes what pages gone left behind
  - i18n: `src/lib/i18n/index.svelte.ts` — uses `$state` rune for reactive locale
  - Runtime config: `src/lib/config.svelte.ts` — uses `$state` rune, injected via SSR (`+layout.server.ts`)
  - Production server: `src/server/` (compiled by `tsconfig.server.json` to `dist/server/`, started by `entrypoint.sh`) — a Node server in front of SvelteKit. `/api/*`, `/robots.txt` and `/sitemap.xml` stream straight to the API (`apiProxy.ts`, with `X-Forwarded-For` rewritten from `ADDRESS_HEADER`/`XFF_DEPTH` in `clientAddress.ts`); everything else goes to adapter-node's `build/handler.js`, with the public origin fixed from `ORIGIN` (`origin.ts`; `entrypoint.sh` sets it from `APP_URL`) since adapter-node 6 dropped that variable. API requests never cross SvelteKit, so its form CSRF check keeps guarding the app without blocking API clients that send no `Origin` (the SDK from Node). In dev, Vite's `server.proxy` plays this role

- **`packages/sdk-js`** (`@largerio/secret-sdk`) — JS/TS SDK; the **only published npm package**
  - `SecretClient` class: create, read, check, delete notes
  - Handles full encrypt→send and receive→decrypt flows. Format 1 streams: a file may be a `Blob`, read a slice at a time as it is encrypted, a session is opened before encrypting, and `readNoteInto` writes each file to a `WritableStream` of the caller's, closed once the note is checked and aborted otherwise (`sealNoteFormat1`, `streamNoteFormat1` in `format1.ts`)
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

- **The protocol is specified in `PROTOCOL.md`** (format 0, the one the app wrote up to 1.5 and the SDK up to 1.2, still read and accepted: keys, payload, single-shot and chunked notes, the API flows; and format 1, its successor, which the web app and the SDK write by default: its envelope, one secretstream whose body is padded to a size class, proof of reading; format numbers are not app versions). A change to the format, the payload, a read or upload endpoint, or a limit a client must respect goes there in the same PR, with new test vectors when the bytes change.
- **Double encryption**: Client encrypts with XChaCha20-Poly1305, server re-encrypts with AES-256-GCM. Removing either layer is a security model change.
- **URL fragment for keys**: The `#key` part of URLs is never sent to the server. This is the foundation of zero-knowledge.
- **Storage abstraction**: `StorageBackend` interface with `LocalStorage` and `S3Storage` implementations. Routes never import storage directly — they use the interface from Hono context.
- **Text in DB, files on disk/S3**: Notes with `fileCount === 0` store encrypted data in SQLite. Notes with files store it on filesystem or S3 (opaque key in `filePath` column).
- **Multipart upload**: `POST /api/v1/notes/upload` accepts binary data (no base64 overhead) for large files with progress tracking.
- **API versioning**: All note and config endpoints under `/api/v1/`. OpenAPI 3.1 spec auto-generated from Zod schemas via `@hono/zod-openapi`.
- **SDK-first frontend**: The web app consumes `@largerio/secret-sdk` (dog-fooding). No direct API calls or crypto operations in the frontend.
- **Write auth**: creating (`POST /notes`, `/notes/upload`, `/notes/upload/init`) and deleting a note require either a PoW token (`X-Cap-Token` header, via `@cap.js/server`) or an API key (`Authorization: Bearer <key>`). Reads stay open (`POST /notes/{id}/reads` carries a format 1 note's proofs, not write auth). Cap endpoints at `/api/cap/` (internal, not documented). SDK API keys configured via `API_KEY` env var (or `API_KEY_1`, `API_KEY_2`, etc. for multiple clients).

## Code Style

- **Formatter**: Biome 2.5 — tabs, 100-char lines, double quotes, semicolons always
- **TypeScript**: Strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noNonNullAssertion`)
- **No `any`**: Biome enforces `noExplicitAny`
- **Imports**: Use `type` imports for type-only (`import type { ... }`)
- **Async storage**: All `StorageBackend` methods are async (return `Promise`)
- **Error handling**: Errors answer problem details with a stable `code` (`problem()`, `ProblemException`); a new error gets a code in PROTOCOL.md's table — never leak internal details

## Gotchas

- **`exactOptionalPropertyTypes`**: You cannot write `salt: salt ?? undefined`. Use conditional spread instead: `...(salt ? { salt } : {})`.
- **Svelte 5 reactive modules**: Files using `$state`/`$derived` outside components must use the `.svelte.ts` extension (e.g. `config.svelte.ts`, `index.svelte.ts`).
- **Biome + Svelte**: `biome.json` has overrides for `**/*.svelte` that disable `noUnusedVariables`, `noUnusedImports`, and `organizeImports` — Biome doesn't understand Svelte template references and produces false positives.
- **Uint8Array in TS 6**: `new Blob([uint8array])` fails because `Uint8Array<ArrayBufferLike>` isn't assignable to `BlobPart`. Cast with `as BlobPart[]`.
- **`#lib` imports (web)**: SvelteKit 3 dropped `$lib`; `#lib/*` is a package.json subpath import, so the extension is mandatory — `#lib/utils/format.js` for `format.ts`, `#lib/theme.svelte.js` for `theme.svelte.ts`, `#lib/components/Icon.svelte` for components.

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

The coverage gate (`vitest.config.ts`) only measures `.ts` sources (this also covers `*.svelte.ts` rune modules; `.svelte`/`.css` files are outside the parser). Files explicitly excluded from the gate: `**/*.d.ts`, the package barrels (`packages/*/src/index.ts`, `packages/crypto/src/client.ts`), the entry points (`apps/api/src/index.ts`, `apps/api/src/backup.ts`, `apps/web/src/server/index.ts`), `**/*.test.ts` + `**/__tests__/**`, `**/types.ts` (type-only), `**/storage/interface.ts` (pure interface), and the frontend's `apps/web/src/routes/**` (loaders) + `apps/web/src/lib/server/**` (`$app/env`/SSR SDK) — these need a render/SvelteKit harness to exercise. So "100%" means 100% of the gated `.ts` logic, not literally every file.

Coverage scope for `apps/web/src`: logic modules and utils are gated (e.g. `lib/notes/*` — its worker's `notes.worker.ts` entry excepted —, `lib/*.svelte.ts` rune stores, `lib/i18n/index.svelte.ts`, `lib/utils/*`, `hooks.server.ts`, and the production server in `server/*` — its `index.ts` bootstrap excepted). Excluded from the gate (need a render/SvelteKit harness): `.svelte` components, `routes/**` loaders, and `lib/server/**` (`$app/env`/SSR SDK). End-to-end flows are covered separately by Playwright in `apps/e2e` (`pnpm test:e2e`).

Run `pnpm test` before committing. New features must include tests.

### Patterns

- API tests use Hono's `app.request()` — no HTTP server needed. They run on the real `createApp` (middleware, limits, auth, error handler), configured through `parseConfig` as an operator would (`__tests__/testApp.ts`); `sdk.test.ts` serves it over HTTP on a free port and points the real SDK at it
- App assembly is split into testable factories: `parseConfig` (`apps/api/src/config.ts`), `createApp` (`apps/api/src/app.ts`), `createNotesService` (`apps/api/src/notes/service.ts`, testable without HTTP), and `startInstance` (`apps/api/src/instance.ts`: the app, its jobs and the one metrics registry they share); `index.ts` is thin bootstrap glue
- Database tests use real SQLite (file-based, cleaned up in `beforeEach`)
- S3 tests mock `@aws-sdk/client-s3` with class-based mocks
- Crypto tests require `await initSodium()` in `beforeAll`. The test vectors in `packages/shared/src/test-vectors/vectors.json` are frozen: `generate-test-vectors.test.ts` recomputes them with libsodium and fails on any difference (`UPDATE_TEST_VECTORS=1` rewrites the file after a deliberate format change). Format 0's `secretstream` section (chunked notes) is written once, its header being random; format 1's notes are recomputed every run under a fixed header (libsodium's `init_pull` state of a header pushes as its writer's would), with the size classes and what a reader must refuse (`format1.invalid`). `test-vectors.test.ts` checks the crypto package against them (reading and writing), the SDK's `crypto.test.ts` and `format1.test.ts` check its notes, and `vectors-openssl.test.ts` checks them with a second implementation, OpenSSL through `node:crypto` (HChaCha20 + ChaCha20-Poly1305, Argon2id, secretstream from OpenSSL's ChaCha20 and a Poly1305 of its own), which shares no code with libsodium, and a format 1 reader written from PROTOCOL.md
- Frontend logic tests run under jsdom; `$state` rune modules need the `.svelte.ts` extension and the `web` Vitest project to compile
- Test files live in `__tests__/` directories alongside source
