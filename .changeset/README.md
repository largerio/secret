# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
It versions the two packages published to npm, `@largerio/secret-sdk` and
`@largerio/secret-cli`.

In a PR that changes either in a way users will notice, run `pnpm changeset`:
pick the bump of each package it touches, describe the change, and commit the
file it writes here. CI does the rest when the PR is merged: see
[docs/releasing.md](../docs/releasing.md#npm-packages).
