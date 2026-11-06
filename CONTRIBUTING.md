# Contributing

Thank you for your interest in contributing to Secret.

## Prerequisites

- **Node.js >= 26** — the code uses `node:sqlite` and `Error.isError`, which
  are not available in Node 22. Check with `node --version`; with nvm, run
  `nvm use 26`.
- **pnpm 10** — `corepack enable` picks up the version pinned in `package.json`.
- **Docker** (optional) — only needed for the containerized workflow below.

## Getting Started

```bash
git clone https://github.com/largerio/secret.git
cd secret
pnpm install

# The API reads its config from the shell environment (there is no dotenv
# loader), so export a key before starting it:
export SERVER_ENCRYPTION_KEY=$(openssl rand -base64 32)

pnpm dev
```

This starts the API on `http://localhost:3001` and the web app on `http://localhost:5173`.

The key must decode to exactly 32 bytes; the server refuses to start otherwise.
Keep the same key across restarts, or the notes you created earlier become
unreadable (the server detects this and refuses to boot).

### With Docker

The `Makefile` wraps `docker-compose.dev.yml` and needs no local Node install —
it ships a working dev key out of the box:

```bash
make dev          # API + web with live reload
make check        # lint + typecheck + test
make shell        # a shell inside the dev container
```

## Development Workflow

1. Create a branch from `main`
2. Make your changes
3. Run checks:

```bash
pnpm lint          # Biome lint + format
pnpm typecheck     # TypeScript strict
pnpm test          # The whole suite must pass
pnpm test:coverage # Same, plus the 100% coverage gate CI enforces
pnpm test:e2e      # Playwright end-to-end suite (needs a browser install)
```

The first time you run the e2e suite:

```bash
pnpm --filter @largerio/e2e exec playwright install --with-deps chromium
```

It builds the web app and starts the API serving it, as the image does. CI
runs it against the image instead, on S3
storage: `.github/scripts/e2e-image.sh <image>` starts both, then
`E2E_BASE_URL=http://localhost:3000 pnpm test:e2e` targets them.

The command line runs against the same image, installed with npm from its
packed tarball and the SDK's, as a user installs it. Start the image with an
API key of 32 characters at least in `E2E_API_KEY`, build the SDK and the CLI
(`pnpm --filter @largerio/secret-sdk --filter @largerio/secret-cli build`),
then run `.github/scripts/e2e-cli.sh http://localhost:3000` with the same
`E2E_API_KEY`. CI runs it on Node 22, the oldest the CLI supports.

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
apps/api/           Backend (Hono, Node.js 26, SQLite)
apps/web/           Frontend (SvelteKit, Svelte 5, Tailwind CSS 4)
apps/e2e/           Playwright end-to-end tests (incl. the axe-core a11y gate)
packages/sdk-js/    JS/TS SDK (SecretClient, encrypt/decrypt flows)
packages/cli/       Command line (`secret`), built on the SDK
packages/crypto/    Encryption library (libsodium, AES-256-GCM)
packages/shared/    Shared types, Zod schemas, constants
messages/           i18n translations (10 languages)
```

### Where to put things

- **New API endpoint** — `apps/api/src/routes/`
- **New validation schema** — `packages/shared/src/validation.ts`
- **New type** — `packages/shared/src/types.ts` (export from `index.ts`)
- **New constant** — `packages/shared/src/constants.ts` (export from `index.ts`)
- **New SDK feature** — `packages/sdk-js/src/`
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

Translations live in `messages/*.json` (10 languages: en, fr, es, de, pt, it, ja, zh, ru, ko).

### Adding a string

1. Add the key to **every** language file — `key-parity.test.ts` fails otherwise
2. Use `t("key_name")` in Svelte components
3. Use `t("key_name", { param: value })` for interpolation

### Adding a language

Dropping a JSON file in `messages/` is not enough; register it in four places:

1. `packages/shared/src/site.ts` — add the code to `LOCALES`, which the server
   picks a visitor's language from
2. `apps/web/src/lib/i18n/index.svelte.ts` — import the file and add the entry to
   the `messages` record
3. `apps/web/src/lib/components/LangMenu.svelte` — add it to `LANGS`
4. `apps/api/src/site/shell.ts` — add its `og:locale` to `OG_LOCALES`

The API reads every language's file at startup, to write the pages' heads.

## Releases

Two packages are published to npm: the SDK, `@largerio/secret-sdk`, and the
command line, `@largerio/secret-cli`, which depends on it. Their releases are
driven by [changesets](https://github.com/changesets/changesets). Add one in
the same PR as any user-visible change to either:

```bash
pnpm changeset
```

On merge to `main`, the Release npm packages workflow (`release.yml`) collects
pending changesets into a "chore: version packages" PR. Merging *that*
publishes the versions npm does not have yet, of either package, via OIDC
trusted publishing — no token is stored. Both packages are built in a job with
a read-only token and no secret, and checked there as they will ship:
`verify-package` packs each with pnpm and runs it from its tarball. The job
that publishes them installs only what changesets and pnpm need, runs no
package's script, and publishes that build. Each version published gets its
git tag and GitHub release (`@largerio/secret-cli@0.1.0`), which takes the
Latest badge: the app's release takes it back with `gh release create --latest`.

The CLI depends on the SDK through `workspace:^`, which pnpm publishes as
`^<the SDK's version>`. A release of the SDK alone does not release the CLI:
the published CLI takes the SDK's later minors and patches. A change to the
CLI that needs something new in the SDK takes a changeset for each.

The workflow opens that PR as a GitHub App rather than with the default
`GITHUB_TOKEN`, because GitHub suppresses `pull_request` events for actions
taken by `GITHUB_TOKEN`: the version PR would otherwise reach `main` with no CI
run at all. The same App arms auto-merge on the Dependabot PRs labeled
`auto-merge-48h` (`dependabot-delayed-merge.yml`): a merge made with
`GITHUB_TOKEN` starts no workflow on `main`, so nothing would be built, scanned
or deployed.

Maintainers configuring a fork need an App installed on the repository with
two repository permissions — Contents (read/write) and Pull requests
(read/write) — its Client ID in the `APP_CLIENT_ID` variable and its private
key in the `APP_PRIVATE_KEY` secret. Each workflow scopes its token down to
what it needs. Without the App both workflows fall back to `GITHUB_TOKEN`:
releases still ship, but the version PR gets no CI run and Dependabot merges
never reach the CI/CD pipeline.

### A new package on npm

npm attaches a trusted publisher only to a package that exists, so the
workflow cannot publish the first version of a new one, such as
`@largerio/secret-cli` 0.1.0. Before merging the Version Packages PR that brings it,
a maintainer who can publish to the `@largerio` scope:

1. Publishes a placeholder by hand, version `0.0.0`, from an empty directory,
   so that the first real version still comes from the workflow, with its
   provenance:

   ```bash
   mkdir secret-cli-placeholder && cd secret-cli-placeholder
   cat > package.json <<'JSON'
   {
     "name": "@largerio/secret-cli",
     "version": "0.0.0",
     "description": "Placeholder: install a later version.",
     "license": "MIT",
     "repository": { "type": "git", "url": "git+https://github.com/largerio/secret.git" }
   }
   JSON
   npm publish --access public
   ```

2. On npmjs.com, in the package's settings, adds a trusted publisher: GitHub
   Actions, organization `largerio`, repository `secret`, workflow
   `release.yml`, and no environment, since the job that publishes runs in
   none. The file name is what npm checks: renaming `release.yml` stops every
   publish until the publishers of both packages are updated.
3. Under publishing access, requires two-factor authentication and disallows
   tokens: the workflow needs none.
4. Merges the Version Packages PR: the workflow publishes the first version.
5. Deprecates the placeholder:
   `npm deprecate @largerio/secret-cli@0.0.0 "Placeholder: install a later version."`

Publishing the first version by hand instead works too, but without
provenance, and the workflow then skips it. If the Version Packages PR is
merged before the trusted publisher is set, the publish of the new package
fails: set it, then re-run the failed `release` job, whose build is kept seven
days.

### Dependencies

- pnpm resolves no version published less than two days ago
  (`minimumReleaseAge` in `pnpm-workspace.yaml`), so a compromised release has
  time to be yanked before it reaches the lockfile. To take an urgent fix
  sooner, list its package under `minimumReleaseAgeExclude` for that update.
- Dependabot proposes no npm package or action less than three days old. Its
  npm patch and minor PRs, and its bumps of the base image digest in the
  Dockerfiles, are labeled `auto-merge-48h` and merged once 48 hours old and
  green. Majors and GitHub Actions updates are reviewed and merged by hand: an
  action runs with the tokens and secrets of the workflows that use it.

### The app image

The app is released by tagging the commit of `main` that adds its
[CHANGELOG.md](CHANGELOG.md) entry, once its CI/CD run is green:

```bash
git tag v1.4.0 <commit> && git push origin v1.4.0
```

Nothing is rebuilt: `release-image.yml` gives the image CI tested for that
commit its release tags (`:1.4.0`, `:1.4`, `:1`, `:latest`). Production follows
`main` and is not redeployed. Once that run is green, publish the release
(`gh release create`), starting its notes from the CHANGELOG entry, with the
line the run's summary gives: the digest of the web app the image serves
([SECURITY.md](SECURITY.md#verifying-the-web-app)).

Only that commit's image reports the version: an image of any later commit
reports it suffixed `-dev`. So `release-image.yml` refuses a tag on any other
commit and names the one to tag, and every promotion checks the version the
image reports.

A merge right after the release can leave the release commit without an
image: GitHub cancels a pending run when a newer one queues. Re-run that
commit's CI/CD run, then the Release image run. Once `main` has moved on, a
re-run tags the image `sha-<commit>` but neither moves `:main` nor deploys.

Every week, `rebuild-release.yml` rebuilds the latest release if its base image
has a newer digest, and moves `:1`, `:1.4` and `:latest` to the rebuild, as
long as it serves the release's web app, by digest. Every
tag moves through `.github/actions/promote-image`: a Trivy scan, the smoke test
(`.github/actions/check-image`) and a signature check come first. The two
workflows that build an image run `check-image` for `linux/arm64` before, on an
arm64 runner, then sign the image in `promote-image` and attest its provenance;
a release only checks the signature `deploy.yml` left. Renaming either of them changes the signing identity
self-hosters verify ([docs/self-hosting.md](docs/self-hosting.md#verifying-the-image)).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
