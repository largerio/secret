# CLAUDE.md

Context for AI agents working in this repository. People should start with
[CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

Secret shares notes and files end-to-end encrypted. The browser (or the SDK,
or the CLI) encrypts before sending; the server adds a second layer
(AES-256-GCM) but never sees the plaintext. The key lives in the URL fragment
(`#key`), which browsers never send. One process serves the API and the web
app's static build.

## Rules

- **Zero-knowledge.** Plaintext, keys and passwords never reach the server.
  Never log note content, note ids, raw paths, keys or IP addresses: logs and
  metric labels hold route patterns and bounded values only.
- **Two encryption layers**: XChaCha20-Poly1305 in the client, AES-256-GCM
  on the server. Removing either is a change to the security model.
- **The protocol is specified in [PROTOCOL.md](PROTOCOL.md)**: format 1, which
  every client writes, and format 0 in an appendix, which instances read and
  accept for all of 1.x. A change to the format, the payload, a read or
  upload endpoint, a limit a client must respect, or an error code goes into
  PROTOCOL.md in the same PR, with new test vectors when the bytes change.
- **Errors** answer problem details (RFC 9457) with a stable `code`:
  `problem()` in middlewares, `NoteError` in the notes service (turned into a
  `ProblemException` with its status by `routes/notes/errorStatus.ts`), and
  the route schemas' `defaultHook` for validation. A new code goes in
  PROTOCOL.md's "Errors" table. Never leak internal details. A 500 is
  logged with an `errorId`; refusals (4xx, 507) aren't logged.
- **Docs describe the current version only**; history goes in
  `CHANGELOG.md`. A user-visible app change adds an entry under
  `[Unreleased]` in `CHANGELOG.md`. An SDK or CLI change adds a changeset
  (`pnpm changeset`).
- **Tests**: 100% coverage of the gated `.ts` files (see [Testing](#testing)).
  New code comes with tests.
- **Never commit** `.env` (it holds `SERVER_ENCRYPTION_KEY`) or `./data/`.
- **Commits** follow Conventional Commits. Merging to `main` deploys
  production.

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # API on :3000 + Vite dev server on :5173 (proxies /api)
pnpm lint             # Biome lint + format check (pnpm lint:fix to fix)
pnpm typecheck        # TypeScript strict, all packages
pnpm test             # all tests (vitest)
pnpm test:coverage    # same, with the 100% coverage gate CI enforces
pnpm test:e2e         # Playwright end-to-end tests (builds the web app first)
pnpm build            # production build, all packages
make check            # lint + typecheck + test in Docker (docker-compose.dev.yml)
```

Schema change: edit `apps/api/src/db/schema.ts`, run `pnpm db:generate` in
`apps/api`, and add the emitted SQL as a new `MIGRATIONS` entry in
`apps/api/src/db/migrations.ts`.

## Environment

- **Node.js 26 or later.** The code uses `Error.isError` and `node:sqlite`;
  older Node fails at runtime (`Error.isError is not a function`). pnpm
  workspaces, ES modules throughout.
- In the Claude Code app's container (no Docker image), Node defaults to an
  older version and nvm lives in `/opt/nvm`. Before running anything:
  ```bash
  export NVM_DIR="/opt/nvm" && . "$NVM_DIR/nvm.sh"
  nvm install 26 && nvm use 26
  pnpm install   # again, so native deps build against Node 26
  ```
  Re-source nvm in each new shell: environment variables don't persist
  between commands.
- The API reads its config from the environment (no dotenv): `pnpm dev`
  needs `SERVER_ENCRYPTION_KEY` exported. SQLite data goes in `./data/`.

## Repository map

**`apps/api`**: Hono server, Node 26.

- `src/notes/`: the notes' rules, with no HTTP. The infrastructure (db,
  storage, quota, pending deletions) never imports it.
  - `service.ts`: `createNotesService`: create, check, read, delete, upload
    sessions (`uploads.ts`); what spends a read, what burns a note.
    `read`/`stream` serve format 0, `readWithProofs` format 1.
  - `rows.ts`: the only place rows are built and read: placement, read
    spending, password attempts (counted before comparing, given back on a
    match, the fifth wrong one deletes the note), `removeNote` (row deleted
    and purge queued in one transaction).
  - `formats.ts` (what each format declares), `serverLayer.ts` (AES-GCM
    layer, verifier sealing), `padding.ts`, `stream.ts`, `limits.ts`,
    `errors.ts` (`NoteError`).
- `src/routes/`: thin handlers. Every route goes through `app.openapi`, with
  its schema in `routes/notes/openapi-routes.ts`. Write auth (proof of work or
  API key) is middleware on the write routes, before validation.
- `src/middleware/`: rate limits (`rateLimit.ts`, client address from
  `ADDRESS_HEADER`/`XFF_DEPTH` or `TRUSTED_PROXIES`), security headers
  (`security.ts`), problem details (`problem.ts`), request id and logs
  (`requestContext.ts`).
- `src/site/`: serves `apps/web/build/` from memory. `load.ts` refuses to
  start on a bad build, or an `en.json` missing a head message
  (`HEAD_MESSAGES`). `shell.ts` renders `index.html` per page × language ×
  theme (head, meta, shell data); `scripts.ts` lists inline scripts' hashes
  for the CSP. Without a build, the API serves itself alone.
- `src/db/`: SQLite (`node:sqlite`) + Drizzle. Migrations run at boot
  (`PRAGMA user_version`); a database newer than the build refuses to start.
- `src/storage/`: `StorageBackend` (local, S3), always async, reached through
  the Hono context, never imported by routes.
- Jobs: `cleanup.ts` (expired notes), `pendingDeletions.ts` (purge outbox),
  `reconcile.ts` (daily orphan sweep, only on storage this database claimed).
- Assembly: `config.ts` (`parseConfig`, `readSecret` for `NAME_FILE`),
  `app.ts` (`createApp`), `instance.ts` (`startInstance`), `index.ts`
  (bootstrap only). Also `backup.ts`, `metrics.ts`, `logger.ts`.

**`apps/web`**: SvelteKit 3 static SPA (Svelte 5, Tailwind CSS 4).

- adapter-static and `ssr = false`, configured in `vite.config.ts`
  (SvelteKit 3 refuses a `svelte.config.js`).
- `src/app.html` carries `SHELL_HTML_TAG` and `SHELL_HEAD_MARKER`, which the
  API fills per request. The page starts from the shell data (`lib/shell.ts`,
  from `hooks.client.ts`). Pages only set `<title>`, with the shared
  `pageTitle`.
- The SDK runs in a module worker (`lib/notes/`: `notes.worker.ts`,
  `worker.ts`; pages call `notes.ts`). Pages never load libsodium, and never
  call the API directly, except `/api/v1/config` under `vite dev`.
- `lib/notes/staging.ts` decrypts files into the origin private file system,
  deleted when the note is closed.
- The build is reproducible: `scripts/bundle-manifest.ts` writes
  `build/bundle.json`, with no timestamps and no precompression.
  `scripts/verify-web-app.sh` checks an instance against a build.

**`packages/sdk-js`** (`@largerio/secret-sdk`, on npm): `SecretClient`;
format 1 streaming in `format1.ts`. tsup bundles `crypto` and `shared`;
`libsodium-wrappers-sumo` and `@msgpack/msgpack` stay external.

**`packages/cli`** (`@largerio/secret-cli`, on npm, Node 22 or later): uses
the SDK's public API and `node:*` only, never `crypto` or `shared`.
`run(argv, io)` (`src/run.ts`) works over an injected `Io` and never throws;
`src/bin.ts` is the real entry. The link only ever goes to stdout, and errors
never include the link, a key or a password.

**`packages/crypto`** and **`packages/shared`**: private, compiled with `tsc`
because the API imports them. `shared` holds the Zod schemas (also used for
OpenAPI), types, constants, `site.ts` (what the server and the web app agree
on for a page), `bundle.ts` (the web app's digest) and the test vectors.

**`apps/e2e`**: Playwright, with an axe-core accessibility gate.

## Code style and gotchas

- Biome 2.5: tabs, 100-character lines, double quotes, semicolons.
- TypeScript strict, with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` and `noNonNullAssertion`. No `any`. Use
  `import type` for type-only imports.
- `exactOptionalPropertyTypes`: you can't write `salt: salt ?? undefined`.
  Use a conditional spread: `...(salt ? { salt } : {})`.
- Files that use `$state`/`$derived` outside components must end in
  `.svelte.ts`.
- `biome.json` turns off `noUnusedVariables`, `noUnusedImports` and
  `organizeImports` for `**/*.svelte`: Biome doesn't see template references.
- TS 6: `new Blob([uint8array])` fails to typecheck; cast with
  `as BlobPart[]`.
- Web imports use `#lib/*` (a package.json subpath import; SvelteKit 3 dropped
  `$lib`), and the extension is mandatory: `#lib/utils/format.js` for
  `format.ts`, `#lib/theme.svelte.js` for `theme.svelte.ts`,
  `#lib/components/Icon.svelte`.

## Testing

- Vitest runs two projects (`vitest.config.ts`): `node` for `packages/*` and
  `apps/api`, and `web` (jsdom + Svelte, `apps/web/vitest.config.ts`).
- The coverage gate requires 100% of statements, branches, functions and
  lines in every `.ts` file, `*.svelte.ts` included, except: `*.d.ts`, the
  package barrels (`packages/*/src/index.ts`, `packages/crypto/src/client.ts`),
  the entry points (`apps/api/src/index.ts`, `apps/api/src/backup.ts`,
  `packages/cli/src/bin.ts`, `apps/web/scripts/bundle-manifest.ts`,
  `apps/web/src/lib/notes/notes.worker.ts`), tests, `**/types.ts`,
  `**/storage/interface.ts`, and `apps/web/src/routes/**`. `.svelte` files
  aren't measured. Any other new `.ts` file must be fully covered.
- Tests live in `__tests__/` next to the source.
- API tests call `app.request()` on the real `createApp`, configured through
  `parseConfig` (`__tests__/testApp.ts`). `sdk.test.ts`, `cli.test.ts` and
  `cliVectors.test.ts` run the real SDK and CLI against the app over HTTP;
  `proofOfWork.test.ts` runs the CLI's solver against the app's Cap.
- The CLI's unit tests run `run(argv, io)` over fake streams, terminal and
  clients.
- Database tests use real SQLite files, cleaned up in `beforeEach`. S3 tests
  mock `@aws-sdk/client-s3` with class-based mocks. Crypto tests call
  `await initSodium()` in `beforeAll`.
- The test vectors (`packages/shared/src/test-vectors/vectors.json`) are
  frozen: `generate-test-vectors.test.ts` recomputes them and fails on any
  difference. Rewrite them with `UPDATE_TEST_VECTORS=1` only after a
  deliberate format change. `vectors-openssl.test.ts` checks them against a
  second implementation, OpenSSL through `node:crypto`.
