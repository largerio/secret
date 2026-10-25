# Changelog

Notable changes to the Secret app, published as the `ghcr.io/largerio/secret`
image. Each version links to its GitHub release. The SDK has
[its own changelog](packages/sdk-js/CHANGELOG.md), and
[SECURITY.md](SECURITY.md#supported-versions) lists the supported versions.

## [Unreleased]

### Security

- Images are signed (cosign, keyless) and carry a SLSA build provenance
  attestation, from the workflow that built them and only once they have
  passed the scan and the smoke test. A release only tags a signed image. See
  [Verifying the image](docs/self-hosting.md#verifying-the-image).

### Fixed

- A generated password always holds a character of every class it draws from.
  About one in five had no symbol.

### Removed

- `POST /api/cap/verify`, which nothing called.

### Upgrade notes

- Migration 3 drops two unused columns and an index. Back up the data volume
  first: once migrated, the database no longer starts on 1.3.2 or older.

## [1.3.2] - 2026-10-24

### Security

- The web server no longer receives the API's secrets: the entrypoint removes
  `SERVER_ENCRYPTION_KEY`, `API_KEY`/`API_KEY_<n>` and the S3 and AWS
  credentials from its environment. A compromised web dependency that dumps
  its environment finds none of them. This is not isolation: both processes
  still run as the same user.

### Changed

- Built on `node:26-alpine` with Node 26.12.1, Alpine 3.24.3 and OpenSSL 3.5.9.
  (#218)
- A release ships the exact image CI tested on `main`, and `:1` picks up
  base-image fixes between releases. (#215)

### Fixed

- A trailing slash in `APP_URL` no longer breaks the sitemap, the Open Graph
  image URL or CORS.
- `S3_FORCE_PATH_STYLE=1` now turns path-style on, like `true`.
- A `CLEANUP_INTERVAL_MS` above 2147483647 (about 24 days) is refused instead
  of running the cleanup every millisecond.
- On `docker stop`, the web server now exits within Docker's 10-second limit.
- Building the image from a working copy no longer copies its `node_modules`
  and build output.

### Upgrade notes

- The server stops at startup with an error on a value it cannot read: an
  on/off setting other than `true`, `false`, `1`, `0` or blank (such as `yes`),
  an `APP_URL` that is not an `http://` or `https://` URL, or an out-of-range
  `API_PORT` or `CLEANUP_INTERVAL_MS`.
- No database migration.

## [1.3.1] - 2026-10-23

### Fixed

- A failed read no longer burns a note: the read is counted, and a
  burn-after-read note deleted, only once its payload has been read and
  decrypted. (#214)
- For notes with files, a corrupt first chunk returns an error before the
  download starts. (#214)

## [1.3.0] - 2026-10-22

### Security

- Per-IP rate limits tell clients apart out of the box: the image trusts its
  own web app (`TRUSTED_PROXIES=127.0.0.1/32`), and IPv6 clients are grouped
  by /64. (#201)
- Every request body is bounded, including on unauthenticated routes. (#202)
- No third-party requests: fonts are served by the instance. (#199)

### Changed

- Instances no longer carry the public instance's branding, and
  `APP_PRIMARY_COLOR` takes effect. (#206)
- `:latest` follows releases; the tip of `main` is `:main`. (#197)

### Fixed

- Plain HTTP on a local network (`http://<ip>:3000`) works again. (#203)
- A wrong password on a read-once note says the note is gone. (#200)
- The web app uploads in the instance's `CHUNK_SIZE`. (#204)
- The Password tab no longer erases the note typed on another tab. (#207)
- Accessible names for the language switch, copy buttons and drop zone. (#210)

### Upgrade notes

- If your `.env` came from an older `.env.example`, `APP_PRIMARY_COLOR` turns
  the interface indigo: remove the line to keep the default.
- A note without files above 512 KiB of ciphertext gets a `413`.

## [1.2.1] - 2026-10-22

### Fixed

- The web server no longer crashes when a client leaves before the API
  answers. (#196)

## [1.2.0] - 2026-10-07

### Changed

- The web server streams request bodies to the API instead of holding them in
  memory.

### Removed

- `BODY_SIZE_LIMIT`: the API enforces the upload cap itself.

### Fixed

- File uploads from the SDK in Node are no longer rejected.

## [1.1.0] - 2026-10-07

### Added

- Storage quotas (`STORAGE_QUOTA_BYTES`), versioned database migrations,
  structured JSON logs, and health checks that probe the database and storage.

### Fixed

- A changed `SERVER_ENCRYPTION_KEY` is refused at startup instead of making
  every note unreadable (`ALLOW_SERVER_KEY_CHANGE` overrides).
- The site is served on `PORT`, as every PaaS expects.

### Upgrade notes

- Back up the data volume first: migrations run on first boot, and a migrated
  database cannot go back to 1.0.0.
- Logs are JSON lines, and the API binds `127.0.0.1` inside the container.

## [1.0.0] - 2026-06-18

First public release.

[Unreleased]: https://github.com/largerio/secret/compare/v1.3.2...HEAD
[1.3.2]: https://github.com/largerio/secret/releases/tag/v1.3.2
[1.3.1]: https://github.com/largerio/secret/releases/tag/v1.3.1
[1.3.0]: https://github.com/largerio/secret/releases/tag/v1.3.0
[1.2.1]: https://github.com/largerio/secret/releases/tag/v1.2.1
[1.2.0]: https://github.com/largerio/secret/releases/tag/v1.2.0
[1.1.0]: https://github.com/largerio/secret/releases/tag/v1.1.0
[1.0.0]: https://github.com/largerio/secret/releases/tag/v1.0.0
