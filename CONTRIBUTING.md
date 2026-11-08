# Contributing

Thanks for your interest in Secret. This guide covers setting up the project,
what a change needs before it's merged, and where things go. Releases are
described for maintainers in [docs/releasing.md](docs/releasing.md).

## Prerequisites

- **Node.js 26 or later.** The code uses `node:sqlite` and `Error.isError`.
  Check with `node --version`; with nvm, run `nvm use 26`.
- **pnpm 10**, through corepack, which picks up the version pinned in
  `package.json`. Node 25 and later don't ship corepack: install the version
  the Dockerfile uses, `npm install -g corepack@0.35.0 && corepack enable`.
- **Docker** (optional), for the containerized workflow below.

## Getting started

```bash
git clone https://github.com/largerio/secret.git
cd secret
pnpm install

# The API reads its config from the shell environment (there is no dotenv
# loader), so export a key before starting it:
export SERVER_ENCRYPTION_KEY=$(openssl rand -base64 32)

pnpm dev
```

This starts the API on `http://localhost:3000` and the web app on
`http://localhost:5173`, whose dev server sends `/api` to the API. `PORT`
moves the API, and the dev server follows it.

The key must decode to exactly 32 bytes, or the server refuses to start. Keep
the same key across restarts: the notes you created earlier can't be read
with another one, and the server refuses to start rather than ignore it.

### With Docker

The `Makefile` wraps `docker-compose.dev.yml`, needs no local Node install,
and ships a working dev key:

```bash
make dev          # API + web with live reload
make check        # lint + typecheck + test
make shell        # a shell inside the dev container
```

## Making a change

1. Create a branch from `main`.
2. Make your change, with tests. New behavior without tests will be asked
   for them.
3. Run the checks:

   ```bash
   pnpm lint            # Biome lint + format
   pnpm typecheck       # TypeScript strict
   pnpm test:coverage   # the whole suite, with the 100% coverage gate CI enforces
   ```

4. Update the docs that describe what you changed:
   - a change people will notice in the app: an entry under `[Unreleased]`
     in [CHANGELOG.md](CHANGELOG.md);
   - a change to the SDK or the command line: a changeset, with
     `pnpm changeset` ([npm packages](docs/releasing.md#npm-packages));
   - a change to the note format, the payload, a read or upload endpoint, a
     limit a client must respect, or a new error code:
     [PROTOCOL.md](PROTOCOL.md), with new test vectors when the bytes change.
5. Commit with a clear message (see [Commit messages](#commit-messages)), and
   open a pull request.

## Code style

We use [Biome](https://biomejs.dev/) for linting and formatting:

- **Indentation**: tabs
- **Line width**: 100 characters
- **Quotes**: double quotes
- **Semicolons**: always

Run `pnpm lint:fix` to fix most issues.

### TypeScript

Strict mode is on, with these additional flags:

- `noUncheckedIndexedAccess`: indexing an array or object returns `T | undefined`
- `exactOptionalPropertyTypes`: `undefined` must be explicit
- `noNonNullAssertion`: no `!` assertions
- `noExplicitAny`: no `any` type (enforced by Biome)

Use `import type { ... }` for type-only imports.

## Project structure

```
apps/api/           Backend (Hono, Node.js 26, SQLite), which also serves the web app
apps/web/           Frontend (SvelteKit, Svelte 5, Tailwind CSS 4), built as static files
apps/e2e/           Playwright end-to-end tests (incl. the axe-core a11y gate)
packages/sdk-js/    JS/TS SDK (SecretClient, encrypt/decrypt flows)
packages/cli/       Command line (`secret`), built on the SDK
packages/crypto/    Encryption library (libsodium, AES-256-GCM)
packages/shared/    Shared types, Zod schemas, constants, crypto test vectors
messages/           i18n translations (10 languages)
```

### Where to put things

- **New API endpoint**: `apps/api/src/routes/`
- **New validation schema**: `packages/shared/src/validation.ts`
- **New type**: `packages/shared/src/types.ts` (export it from `index.ts`)
- **New constant**: `packages/shared/src/constants.ts` (export it from `index.ts`)
- **New SDK feature**: `packages/sdk-js/src/`
- **New crypto function**: `packages/crypto/src/`
- **New UI component**: `apps/web/src/lib/components/`
- **New translation key**: every file in `messages/` (see [i18n](#i18n))
- **Storage backend**: implement the `StorageBackend` interface in `apps/api/src/storage/`

## Testing

We use [Vitest](https://vitest.dev/). Tests live in `__tests__/` directories
next to the source.

```bash
pnpm test              # run once
pnpm test:watch        # watch mode
pnpm test:coverage     # with the coverage gate
```

### Writing tests

- **API routes**: use `app.request()` (Hono's test helper, no HTTP server)
- **Database**: use real SQLite files, cleaned up in `beforeEach`
- **Crypto**: call `await initSodium()` in `beforeAll`
- **S3**: mock `@aws-sdk/client-s3` with class-based mocks (see `s3.test.ts`)

### End-to-end tests

```bash
pnpm --filter @largerio/e2e exec playwright install --with-deps chromium   # the first time
pnpm test:e2e
```

The suite builds the web app and starts the API serving it, as the image
does. CI runs it against the image instead, on S3 storage:
`.github/scripts/e2e-image.sh <image>` starts both, then
`E2E_BASE_URL=http://localhost:3000 pnpm test:e2e` targets them. With the web
app built (`pnpm --filter @largerio/web build`),
`scripts/verify-web-app.sh http://localhost:3000` then checks that the image
serves that very build, as CI does, and as anyone can of an instance
([SECURITY.md](SECURITY.md#verifying-the-web-app)).

The command line runs against the same image, installed with npm from its
packed tarball and the SDK's, as a user installs it. Start the image with an
API key of at least 32 characters in `E2E_API_KEY`, build the SDK and the CLI
(`pnpm --filter @largerio/secret-sdk --filter @largerio/secret-cli build`),
then run `.github/scripts/e2e-cli.sh http://localhost:3000` with the same
`E2E_API_KEY`. CI runs it on Node 22, the oldest the CLI supports.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add S3 storage backend
fix: timing-safe delete token comparison
test: add multipart upload endpoint tests
docs: update README with S3 configuration
refactor: extract storage abstraction layer
```

## Security

Secret is built around one promise: the server never sees what people send.
Please keep in mind:

- **Never log or expose plaintext content.** The server must stay
  zero-knowledge.
- **Validate every input** with Zod schemas; never trust client data.
- **Compare tokens and secrets in constant time** (`crypto.timingSafeEqual`).
- **Zero keys after use** with `sodium.memzero()`.
- **No `eval` or dynamic code execution**: the CSP is strict.
- **Never leak internal details in errors.** An error answers problem details
  with a stable `code`, listed in [PROTOCOL.md](PROTOCOL.md#errors).

If you find a vulnerability, report it privately: see
[SECURITY.md](SECURITY.md#reporting-a-vulnerability).

## i18n

Translations live in `messages/*.json` (10 languages: en, fr, es, de, pt, it,
ja, zh, ru, ko).

### Adding a string

1. Add the key to **every** language file: `key-parity.test.ts` fails
   otherwise.
2. Use `t("key_name")` in Svelte components.
3. Use `t("key_name", { param: value })` for interpolation.

### Adding a language

Add its JSON file to `messages/`, then register it in four places:

1. `packages/shared/src/site.ts`: add the code to `LOCALES`, which the server
   picks a visitor's language from.
2. `apps/web/src/lib/i18n/index.svelte.ts`: import the file and add it to the
   `messages` record.
3. `apps/web/src/lib/components/LangMenu.svelte`: add it to `LANGS`.
4. `apps/api/src/site/shell.ts`: add its `og:locale` to `OG_LOCALES`.

The last three are keyed by `Locale`: once the code is in `LOCALES`,
`pnpm typecheck` names whichever of them still lacks it. The sitemap and the
pages' `hreflang` links follow `LOCALES` on their own.

The API reads every language's file at startup, to write the pages' heads,
and refuses to start when `en.json` lacks one of the messages they need
(`HEAD_MESSAGES` in `apps/api/src/site/messages.ts`). The other languages
fall back to English, message by message.

## Dependencies

- pnpm resolves no version published less than two days ago
  (`minimumReleaseAge` in `pnpm-workspace.yaml`), so a compromised release has
  time to be yanked before it reaches the lockfile. To take an urgent fix
  sooner, list its package under `minimumReleaseAgeExclude` for that update.
- Dependabot proposes no npm package or action less than three days old. Its
  npm patch and minor PRs, and its bumps of the base image digest in the
  Dockerfiles, are labeled `auto-merge-48h` and merged once they're 48 hours
  old and green. Majors and GitHub Actions updates are reviewed and merged by
  hand: an action runs with the tokens and secrets of the workflows that use
  it.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
