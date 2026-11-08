# Releasing

How the app image and the npm packages are released. This is for
maintainers; contributors only need [CONTRIBUTING.md](../CONTRIBUTING.md).

## npm packages

Two packages are published to npm: the SDK, `@largerio/secret-sdk`, and the
command line, `@largerio/secret-cli`, which depends on it. Their releases go
through [changesets](https://github.com/changesets/changesets). A PR that
changes either in a way users will notice adds one:

```bash
pnpm changeset
```

On merge to `main`, the Release npm packages workflow (`release.yml`) collects
the pending changesets into a "chore: version packages" PR. Merging *that* PR
publishes the versions npm doesn't have yet, of either package, through OIDC
trusted publishing: no token is stored. Both packages are built in a job with
a read-only token and no secret, and checked there as they will ship:
`verify-package` packs each with pnpm and runs it from its tarball. The job
that publishes them installs only what changesets and pnpm need, runs no
package's script, and publishes that build. Each version published gets its
git tag and GitHub release (`@largerio/secret-cli@0.1.0`), which takes the
Latest badge: the app's release takes it back with `gh release create --latest`.

The SDK's build (tsup) bundles the private `@largerio/secret-crypto` and
`@largerio/secret-shared` packages, so the SDK installs as one self-contained
package. The CLI's build bundles its own code and leaves the SDK as its one
dependency. In development everything resolves to the TypeScript sources;
`dist/` is built only to pack and publish.

The CLI depends on the SDK through `workspace:^`, which pnpm publishes as
`^<the SDK's version>`. A release of the SDK alone doesn't release the CLI:
the published CLI takes the SDK's later minors and patches. A change to the
CLI that needs something new in the SDK takes a changeset for each.

### The GitHub App

The workflow opens the version PR as a GitHub App rather than with the default
`GITHUB_TOKEN`, because GitHub suppresses `pull_request` events for actions
taken by `GITHUB_TOKEN`: the version PR would otherwise reach `main` with no
CI run at all. The same App arms auto-merge on the Dependabot PRs labeled
`auto-merge-48h` (`dependabot-delayed-merge.yml`): a merge made with
`GITHUB_TOKEN` starts no workflow on `main`, so nothing would be built,
scanned or deployed.

A fork needs an App installed on the repository with two repository
permissions, Contents (read/write) and Pull requests (read/write), its Client
ID in the `APP_CLIENT_ID` variable and its private key in the
`APP_PRIVATE_KEY` secret. Each workflow scopes its token down to what it
needs. Without the App, both workflows fall back to `GITHUB_TOKEN`: releases
still ship, but the version PR gets no CI run, and Dependabot merges never
reach the CI/CD pipeline.

### A new package on npm

npm attaches a trusted publisher only to a package that exists, so the
workflow can't publish the first version of a new one. Before merging the
Version Packages PR that brings it, a maintainer who can publish to the
`@largerio` scope:

1. Publishes a placeholder by hand, version `0.0.0`, from an empty directory,
   so that the first real version still comes from the workflow, with its
   provenance:

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
   `release.yml`, and no environment, since the job that publishes runs in
   none. npm checks the file name: renaming `release.yml` stops every
   publish until the publishers of every package are updated.
3. Under publishing access, requires two-factor authentication and disallows
   tokens: the workflow needs none.
4. Merges the Version Packages PR: the workflow publishes the first version.
5. Deprecates the placeholder:
   `npm deprecate @largerio/<package>@0.0.0 "Placeholder: install a later version."`

Publishing the first version by hand works too, but without provenance, and
the workflow then skips it. If the Version Packages PR is merged before the
trusted publisher is set, the publish of the new package fails: set it, then
re-run the failed `release` job, whose build is kept for seven days.

## The app image

The app is released by tagging the commit of `main` that adds its
[CHANGELOG.md](../CHANGELOG.md) entry, once its CI/CD run is green:

```bash
git tag vX.Y.Z <commit> && git push origin vX.Y.Z
```

Nothing is rebuilt: `release-image.yml` gives the image CI tested for that
commit its release tags (`:X.Y.Z`, `:X.Y`, `:1`, `:latest`). Production
follows `main` and is not redeployed. Once that run is green, publish the
release (`gh release create`), starting its notes from the CHANGELOG entry,
with the line the run's summary gives: the digest of the web app the image
serves ([SECURITY.md](../SECURITY.md#verifying-the-web-app)).

Only that commit's image reports the version: an image of any later commit
reports it suffixed `-dev`. So `release-image.yml` refuses a tag on any other
commit and names the one to tag, and every promotion checks the version the
image reports.

A merge right after the release can leave the release commit without an
image: GitHub cancels a pending run when a newer one queues. Re-run that
commit's CI/CD run, then the Release image run. Once `main` has moved on, a
re-run tags the image `sha-<commit>` but neither moves `:main` nor deploys.

Every week, `rebuild-release.yml` rebuilds the latest release if its base
image has a newer digest, and moves `:1`, `:X.Y` and `:latest` to the
rebuild, as long as it serves the release's web app, by digest. Every tag
moves through `.github/actions/promote-image`: a Trivy scan, the smoke test
(`.github/actions/check-image`) and a signature check come first. The two
workflows that build an image run `check-image` for `linux/arm64` first, on
an arm64 runner, then sign the image in `promote-image` and attest its
provenance; a release only checks the signature `deploy.yml` left. Renaming
either of them changes the signing identity self-hosters verify
([docs/self-hosting.md](self-hosting.md#verifying-the-image)).
