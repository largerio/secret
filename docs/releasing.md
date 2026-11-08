# Releasing

How the app image and the npm packages are released. This is for
maintainers; contributors only need [CONTRIBUTING.md](../CONTRIBUTING.md).

## npm packages

Two packages are published to npm: the SDK, `@largerio/secret-sdk`, and the
command line, `@largerio/secret-cli`, which depends on it. Their releases go
through [changesets](https://github.com/changesets/changesets): a PR that
changes either one in a way users will notice adds a changeset.

```bash
pnpm changeset
```

When such a PR is merged to `main`, the Release npm packages workflow
(`release.yml`) gathers the pending changesets into a "chore: version
packages" PR. Merging *that* PR publishes every version npm doesn't have
yet, through OIDC trusted publishing, so no token is stored anywhere.

The workflow builds both packages in a job that has a read-only token and no
secrets, and checks them there as they'll ship: `verify-package` packs each
one with pnpm and runs it from its tarball. The job that publishes installs
only what changesets and pnpm need, runs no package scripts, and publishes
that build. Each published version gets its git tag and GitHub release (such
as `@largerio/secret-cli@0.1.0`), which takes the Latest badge; the app's
next release takes it back with `gh release create --latest`.

The SDK's build (tsup) bundles the private `@largerio/secret-crypto` and
`@largerio/secret-shared` packages, so the SDK installs as one
self-contained package. The CLI's build bundles its own code, and leaves the
SDK as its only dependency. In development, everything resolves to the
TypeScript sources; `dist/` is only built to pack and publish.

The CLI depends on the SDK through `workspace:^`, which pnpm publishes as
`^<the SDK's version>`. Releasing the SDK alone doesn't release the CLI: the
published CLI picks up the SDK's later minor and patch versions on its own.
A CLI change that needs something new in the SDK takes a changeset for each.

### The GitHub App

The workflow opens the version PR as a GitHub App, not with the default
`GITHUB_TOKEN`. GitHub doesn't trigger `pull_request` events for actions
taken with `GITHUB_TOKEN`, so the version PR would otherwise reach `main`
without any CI run. The same App enables auto-merge on Dependabot PRs
labeled `auto-merge-48h` (`dependabot-delayed-merge.yml`), for the same
reason: a merge made with `GITHUB_TOKEN` starts no workflow on `main`, so
nothing would be built, scanned or deployed.

A fork needs an App installed on the repository with two repository
permissions, Contents (read/write) and Pull requests (read/write). Its
Client ID goes in the `APP_CLIENT_ID` variable, and its private key in the
`APP_PRIVATE_KEY` secret. Each workflow narrows its token to what it needs.
Without the App, both workflows fall back to `GITHUB_TOKEN`: releases still
ship, but the version PR gets no CI run, and Dependabot merges never reach
the CI/CD pipeline.

### A new package on npm

npm can only attach a trusted publisher to a package that already exists,
so the workflow can't publish the first version of a new package. Before
merging the Version Packages PR that introduces it, a maintainer who can
publish to the `@largerio` scope:

1. Publishes a placeholder by hand, version `0.0.0`, from an empty
   directory, so that the first real version still comes from the workflow,
   with its provenance:

   ```bash
   mkdir placeholder && cd placeholder
   cat > package.json <<'JSON'
   {
     "name": "@largerio/<package>",
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
   `release.yml`, and no environment, since the publishing job doesn't run in
   one. npm checks the file name, so renaming `release.yml` stops every
   publish until the trusted publishers of all packages are updated.
3. Under publishing access, requires two-factor authentication and disallows
   tokens, since the workflow doesn't need any.
4. Merges the Version Packages PR. The workflow publishes the first version.
5. Deprecates the placeholder:
   `npm deprecate @largerio/<package>@0.0.0 "Placeholder: install a later version."`

You can also publish the first version by hand, but it then has no
provenance, and the workflow skips it. If the Version Packages PR is merged
before the trusted publisher is set, publishing the new package fails: set
the publisher, then re-run the failed `release` job, whose build is kept for
seven days.

## The app image

To release the app, tag the commit of `main` that adds its
[CHANGELOG.md](../CHANGELOG.md) entry, once that commit's CI/CD run is
green:

```bash
git tag vX.Y.Z <commit> && git push origin vX.Y.Z
```

Nothing is rebuilt: `release-image.yml` gives the image CI already tested
for that commit its release tags (`:X.Y.Z`, `:X.Y`, `:1`, `:latest`).
Production follows `main` and isn't redeployed. Once that run is green,
publish the release with `gh release create`. Start its notes from the
CHANGELOG entry, and add the line the run's summary gives: the digest of the
web app the image serves ([SECURITY.md](../SECURITY.md#verifying-the-web-app)).

Only that commit's image reports the release's version: images of later
commits report it with a `-dev` suffix. So `release-image.yml` refuses a tag
on any other commit, and names the one to tag. Every promotion also checks
the version the image reports.

A merge right after the release commit can leave that commit without an
image, because GitHub cancels a pending run when a newer one is queued.
Re-run that commit's CI/CD run, then the Release image run. Once `main` has
moved on, a re-run tags the image `sha-<commit>`, but neither moves `:main`
nor deploys.

Every week, `rebuild-release.yml` rebuilds the latest release if its base
image has a newer digest, and moves `:1`, `:X.Y` and `:latest` to the
rebuild, as long as it still serves the release's web app, compared by
digest.

Every tag moves through `.github/actions/promote-image`, which runs a Trivy
scan, the smoke test (`.github/actions/check-image`) and a signature check
first. The two workflows that build images first run `check-image` for
`linux/arm64` on an arm64 runner, then sign the image in `promote-image` and
attest its provenance. A release only checks the signature `deploy.yml`
left. Renaming either workflow changes the signing identity self-hosters
verify ([docs/self-hosting.md](self-hosting.md#verifying-the-image)).
