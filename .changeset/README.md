# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
It versions and publishes the three public packages — `@largerio/secret-shared`,
`@largerio/secret-crypto`, and `@largerio/secret-sdk`. The private apps (`@largerio/api`,
`@largerio/web`, `@largerio/e2e`) are ignored.

Workflow:

1. `pnpm changeset` — describe your change and pick the bump (patch/minor/major).
   This writes a markdown file in this folder; commit it with your PR.
2. `pnpm version-packages` — consume pending changesets, bump versions, and
   update changelogs.
3. `pnpm release` — build the packages and publish them to npm. pnpm rewrites
   the `workspace:*` ranges to real versions and applies `publishConfig` (which
   points `exports` at the compiled `dist/` output) at pack time.
