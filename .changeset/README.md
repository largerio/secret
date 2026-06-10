# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
The only published package is **`@largerio/secret-sdk`** — it bundles the internal
`@largerio/secret-crypto` and `@largerio/secret-shared` workspace packages, which
stay private (`"private": true`) along with the apps.

Workflow:

1. `pnpm changeset` — describe your change and pick the bump (patch/minor/major).
   This writes a markdown file in this folder; commit it with your PR.
2. `pnpm version-packages` — consume pending changesets, bump the version, and
   update the changelog.
3. `pnpm release` — build (tsup bundles crypto + shared into the SDK) and publish
   to npm. pnpm applies `publishConfig` (which points `exports` at the compiled
   `dist/` output) at pack time.
