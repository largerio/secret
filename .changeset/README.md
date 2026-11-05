# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
Two packages are published: **`@largerio/secret-sdk`**, which bundles the
internal `@largerio/secret-crypto` and `@largerio/secret-shared` workspace
packages, and **`@largerio/secret-cli`**, the command line, which depends on the
SDK. The internal packages stay private (`"private": true`) along with the apps.

Workflow:

1. `pnpm changeset` — describe your change and pick the bump (patch/minor/major)
   of each package it touches. This writes a markdown file in this folder;
   commit it with your PR.
2. `pnpm version-packages` — consume pending changesets, bump the versions, and
   update the changelogs.
3. `pnpm --filter @largerio/secret-sdk --filter @largerio/secret-cli build`,
   then `pnpm release` — build (tsup bundles crypto + shared into the SDK, and
   the CLI's code, the SDK left out, into its command), then publish what npm
   does not have yet. At pack time pnpm applies `publishConfig`, whose `exports`
   point the SDK at its compiled `dist/` and the CLI at nothing but its manifest
   (its command is its `bin`), and
   turns the CLI's `workspace:^` on the SDK into a version range. In CI the Release npm packages workflow builds in
   a job with no secret, then publishes that build from another, which
   authenticates via **npm trusted publishing (OIDC)** — no token.
