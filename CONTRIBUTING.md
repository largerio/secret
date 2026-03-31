# Contributing

Thank you for your interest in contributing to Secret.

## Getting Started

```bash
git clone https://github.com/largerio/secret.git
cd secret
pnpm install
pnpm dev
```

This starts the API on `http://localhost:3001` and the web app on `http://localhost:5173`.

You'll need a `SERVER_ENCRYPTION_KEY` for the API:

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Paste the output into .env
```

## Development Workflow

1. Create a branch from `main`
2. Make your changes
3. Run checks:

```bash
pnpm lint         # Biome lint + format
pnpm typecheck    # TypeScript strict
pnpm test         # All 154 tests must pass
```

4. Commit with a clear message (see [Commit Messages](#commit-messages))
5. Open a pull request

## Code Style

We use [Biome](https://biomejs.dev/) for linting and formatting:

- **Indentation**: Tabs
- **Line width**: 100 characters
- **Quotes**: Double quotes
- **Semicolons**: Always

Run `pnpm lint:fix` to auto-fix most issues.

### TypeScript

Strict mode is enforced with these additional flags:

- `noUncheckedIndexedAccess` — Array/object indexing returns `T | undefined`
- `exactOptionalPropertyTypes` — `undefined` must be explicit
- `noNonNullAssertion` — No `!` assertions
- `noExplicitAny` — No `any` type (enforced by Biome)

Use `import type { ... }` for type-only imports.

## Project Structure

```
apps/api/       Backend (Hono, Node.js 24, SQLite)
apps/web/       Frontend (SvelteKit, Svelte 5, Tailwind CSS 4)
packages/crypto/    Encryption library (libsodium, AES-256-GCM)
packages/shared/    Shared types, Zod schemas, constants
messages/           i18n translations (en.json, fr.json)
```

### Where to put things

- **New API endpoint** — `apps/api/src/routes/`
- **New validation schema** — `packages/shared/src/validation.ts`
- **New type** — `packages/shared/src/types.ts` (export from `index.ts`)
- **New constant** — `packages/shared/src/constants.ts` (export from `index.ts`)
- **New crypto function** — `packages/crypto/src/`
- **New UI component** — `apps/web/src/lib/components/`
- **New translation key** — `messages/en.json` and `messages/fr.json`
- **Storage backend** — Implement `StorageBackend` interface in `apps/api/src/storage/`

## Testing

We use [Vitest](https://vitest.dev/). Tests live in `__tests__/` directories alongside the source.

```bash
pnpm test              # Run once
pnpm test:watch        # Watch mode
pnpm test:coverage     # With coverage report
```

### Writing Tests

- **API routes**: Use `app.request()` (Hono's test helper, no HTTP server)
- **Database**: Use real SQLite files, clean up in `beforeEach`
- **Crypto**: Call `await initSodium()` in `beforeAll`
- **S3**: Mock `@aws-sdk/client-s3` with class-based mocks (see `s3.test.ts`)
- **New features must include tests** — PRs without tests for new functionality will be requested to add them

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add S3 storage backend
fix: timing-safe delete token comparison
test: add multipart upload endpoint tests
docs: update README with S3 configuration
refactor: extract storage abstraction layer
```

## Security

This is a security-focused application. Please keep in mind:

- **Never log or expose plaintext content** — The server must remain zero-knowledge
- **Validate all inputs** — Use Zod schemas, never trust client data
- **Use timing-safe comparisons** — For tokens and secrets (`crypto.timingSafeEqual`)
- **Zero sensitive memory** — Call `sodium.memzero()` on keys after use
- **No `eval` or dynamic code execution** — CSP is strict
- **Return generic errors** — Never leak internal details in API responses

If you discover a security vulnerability, please report it privately via GitHub Security Advisories rather than opening a public issue.

## i18n

Translations live in `messages/en.json` and `messages/fr.json`. When adding user-facing strings:

1. Add the key to both files
2. Use `t("key_name")` in Svelte components
3. Use `t("key_name", { param: value })` for interpolation

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
