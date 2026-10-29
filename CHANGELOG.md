# Changelog

Notable changes to the Secret app, published as the `ghcr.io/largerio/secret`
image. Each version links to its GitHub release. The SDK has
[its own changelog](packages/sdk-js/CHANGELOG.md), and
[SECURITY.md](SECURITY.md#supported-versions) lists the supported versions.

## [Unreleased]

### Added

- [PROTOCOL.md](https://github.com/largerio/secret/blob/main/PROTOCOL.md) specifies format 0, the encryption format every release so far uses: the keys and the password derivation, the payload, single-shot and chunked notes, the API flows, what the server learns and the limits of this format. With the test vectors, it is enough to write a client in another language. (#249)

## [1.5.0] - 2026-10-28

### Security

- The database now syncs every commit to disk. With the previous setting, a
  power cut could undo the last commits, a read that burned a note among them,
  and the note became readable again.
- `/api/health` no longer reports `storage.usedBytes`: it told anyone how much
  the instance stores. The value is in the metrics, as
  `secret_storage_used_bytes`.

### Added

- Liveness and readiness probes. `/api/health/live` answers as long as the API
  process does; `/api/health/ready` checks the database and the storage. See
  [Monitoring](docs/self-hosting.md#monitoring).
- `/api/health` and the API reference report the version, and `/api/health`
  the commit the image was built from. An image of `main` built after a
  release reports that release suffixed `-dev`.
- Prometheus metrics at `/api/metrics`, off unless `METRICS_TOKEN` is set:
  requests by route, notes created, read, burned, deleted and expired, storage
  used, owed and failed deletions, the storage sweep. No metric carries a note
  id, an address or a path.
- `node apps/api/dist/backup.js <destination>` copies the database while the
  app runs: one consistent snapshot, without the notes already deleted,
  checked, written under a temporary name and renamed into place, never over
  an existing file, readable by its owner alone. Ctrl-C or a job's timeout lets
  the copy finish rather than leave a partial one behind. See
  [Backup & restore](docs/self-hosting.md#backup--restore),
  which now covers the files and the key, the order to back them up in, the
  restore, and what a stolen backup reveals.
- Secrets can be read from files, the way Docker and Kubernetes hand them out:
  `SERVER_ENCRYPTION_KEY_FILE`, `API_KEY_FILE` (and `API_KEY_1_FILE`…),
  `S3_ACCESS_KEY_ID_FILE`, `S3_SECRET_ACCESS_KEY_FILE`, `METRICS_TOKEN_FILE`.
  `docker-compose.yml` passes them all on from `.env`, `API_KEY_1_FILE` to
  `API_KEY_3_FILE` included. See [Secrets in files](docs/self-hosting.md#secrets-in-files).
- The self-hosting guide explains why an instance runs alone on its database
  ([One instance per database](docs/self-hosting.md#one-instance-per-database)),
  and how to keep note creation to your own users behind a login
  ([Restricting who can create notes](docs/self-hosting.md#restricting-who-can-create-notes)),
  with examples for Caddy and Traefik.

### Changed

- The cleanup job deletes expired notes and upload sessions 200 at a time, each
  batch in its own transaction, and lets requests through between batches.
  After a long outage it no longer holds up every request until the whole
  backlog is gone.
- The database waits up to 5 seconds for a lock another connection holds (a
  backup, an operator's `sqlite3` shell) instead of failing at once, and
  truncates its WAL back to 64 MiB after a burst.
- The image hands the generated server key to the API by its path rather than
  its value: no process environment holds the key any more. The web server gets
  none of the `_FILE` variables, nor the metrics token.
- Once the container is stopping, it refuses new connections, and a health
  check still arriving on an open one gets `503` with `"status":"draining"`.
- The `linux/arm64` image is scanned and smoke-tested before any tag points at
  it, like the `linux/amd64` one: it was built, but never run nor scanned.

### Fixed

- Behind a proxy that routes by Docker's health status, such as Traefik, a
  slow or unreachable storage took the whole site down, text notes included:
  the image's `HEALTHCHECK` checked the storage, and an unhealthy container
  gets no traffic. It now polls `/api/health/live`, which only checks that the
  app answers. Point an uptime monitor at `/api/health/ready` to hear about the
  storage; the deploy workflow checks it before it accepts a new image.
- An S3 endpoint that stopped answering held requests, the health check,
  deletions and the storage sweep indefinitely; a stuck deletion also stopped
  the cleanup job until a restart. Connections now give up after 5 seconds and
  requests after 30 seconds without a byte, on each of three attempts; reading
  a note gives up on content that stops arriving for 30 seconds; listings and
  deletions give up after 2 minutes in all, even when the answer stalls after
  its first bytes; the health probe gives up after 5 seconds.
- On shutdown, the API cut in-flight requests after 8 seconds whatever the stop
  grace period: raising `stop_grace_period`, as the reference production
  compose file did, gave long uploads no more time. The API now waits
  `SHUTDOWN_TIMEOUT` seconds (8 by default), like the web server.
- The "Encrypt and create the link" button, disabled until there is something
  to encrypt, lit up as the page appeared, then dimmed: its entrance ended at
  full opacity. Entrances now end on each element's own look.
- The arc that turns around the note's card when it appears or takes the
  focus went unseen while the card had the focus, on arrival included, since
  on a computer the text field takes it on load: it was as light as the rest
  of the ring. It is now lighter than the ring on the light theme, darker on
  the dark one.
- A failed request showed the server's message, in English and meant for
  developers ("Too many requests", "Network request failed"), whatever the
  page's language. It now says what happened in the reader's language: no
  connection, too many requests, the anti-spam check refused, a note larger
  than the server accepts, no room left, a server error. A deletion link whose
  token does not match the note says so, and a note gone in the meantime shows
  "Note not found".
- Opening a note while the server was unreachable or failing said "Decryption
  failed". It now says the server is unavailable, or that the note is gone
  when the failed read was its last.
- Back, after leaving for another site, could show a note already read, or a
  new note's link with the only copy of its key: the browser kept the page as
  it stood (the back-forward cache). The link's page now starts over, and a
  note's page reloads to show where the note stands.
- "Readable N times in total" and the message about ignored attachments now
  agree with their number in every language, Russian's three forms included.
- A request sent right after one the server refused before reading its body
  (a chunk or note too large, a write without a valid token) could fail as a
  network error: the API, and the web server in front of it, announced the
  connection as kept alive, then dropped it while discarding the rest of the
  body. Both now close it with the refusal, and the client opens a new one.
- The read that burns a file note waited for its files to be deleted from the
  storage before answering: a slow S3 kept the reader waiting, for minutes at
  worst. The deletion now runs after the answer; one cut short by a restart is
  retried by the cleanup job, as before.
- An upload to S3 that kept trickling never timed out: only silence did. It
  now gives up after 2 minutes plus 1 second per MiB of the payload, retries
  included.
- `secret_notes_expired_total` missed the expired notes a read found and
  deleted before the cleanup job did.

### Removed

- The inline preview of PDF attachments. It never showed in Chrome, which
  draws a PDF with a plugin, and plugins never run in the sandboxed frame an
  attachment gets. A PDF comes with a download button, like other files, and
  the CSP no longer allows `blob:` frames.

### Upgrade notes

- `/api/health` no longer has `storage.usedBytes`. A script or dashboard that
  read it should scrape `secret_storage_used_bytes` from `/api/metrics`, after
  setting `METRICS_TOKEN`. `/api/health` keeps working otherwise; a health
  check of your own can move to `/api/health/ready` once this version runs.
- The image's `HEALTHCHECK` no longer checks the database and the storage. A
  deploy that waits for the container to turn healthy should then check
  `/api/health/ready` too, as the workflow in
  [Deploying from CI](docs/self-hosting.md#deploying-from-ci) does. A compose
  file that overrides the health check, as the reference production one does,
  should poll `/api/health/live`.
- Keep backups no longer than `MAX_EXPIRY`: a restore brings back every note
  burned or deleted since, for anyone who still has its link. Back up the key
  apart from the data. The volume archive this guide used to recommend held
  both.
- Each write now waits for the disk. On slow storage (spinning disks, a network
  volume), creating and reading notes takes a few milliseconds longer.
- A secret set both as a variable and as a `_FILE`, or a `_FILE` naming a
  missing, unreadable or empty file, stops the server at startup. `KEY_FILE`,
  which was undocumented, still moves the generated key, and plays no part once
  `SERVER_ENCRYPTION_KEY` or `SERVER_ENCRYPTION_KEY_FILE` is set.
- To give in-flight requests more than 8 seconds on shutdown, set
  `SHUTDOWN_TIMEOUT` and raise `stop_grace_period` a couple of seconds above
  it.
- No database migration.

## [1.4.1] - 2026-10-26

### Security

- Note IDs no longer appear in the logs. The cleanup job and the deletion
  retries logged them.

### Added

- A daily storage sweep removes stored files that no note points to any more,
  such as those a failed deletion left behind. Every instance claims its
  storage at startup, and the sweep deletes nothing on storage another database
  has claimed, nor during its first day on a storage, when it only logs what it
  would delete. `STORAGE_RECONCILE=false` turns it off. See
  [Storage cleanup](docs/self-hosting.md#storage-cleanup).

### Fixed

- Deleting a note's files from storage could fail silently: both backends
  swallowed every error, and S3 ignored the keys it refused to delete. Nothing
  was retried, so the ciphertext of burned or expired notes could stay on disk
  or in the bucket. Failures are now logged and retried.
- A deletion is recorded in the same transaction that removes the note, so a
  restart in between no longer strands its files. The same holds while a file
  is being saved, and for a chunk that lands after its upload session expired.
  Such a chunk used to get a `500` and stay; it is now removed and gets a
  `404`, or a `409` if the upload was completed in the meantime.
- The Content Security Policy blocked one of the interface's fonts (the
  monospace font's Cyrillic Extended range), which the build had inlined as a
  `data:` URI: browsers logged a violation and fell back to another font for
  those characters. Every font now ships as a file.

### Upgrade notes

- Migration 4 drops two columns from `pending_deletions`. Back up the data
  volume first: once migrated, the database no longer starts on 1.4.0 or older.
- A day after the upgrade, the storage sweep starts removing files older than a
  day that the database does not know; until then it only logs their count. If
  several instances share a bucket or `FILES_PATH`, give each its own, or set
  `STORAGE_RECONCILE=false` on all of them, before upgrading any: an instance
  that has not upgraded yet leaves no claim, so the others cannot tell its
  files from orphans.
- On S3, the key now also needs to list the bucket and to write under
  `instances/`. Turn versioning off and add the lifecycle rule in
  [S3 bucket settings](docs/self-hosting.md#s3-bucket-settings).

## [1.4.0] - 2026-10-26

### Security

- Images are signed (cosign, keyless) and carry a SLSA build provenance
  attestation, from the workflow that built them and only once they have
  passed the scan and the smoke test. A release only tags a signed image. See
  [Verifying the image](docs/self-hosting.md#verifying-the-image).

### Changed

- A redesigned interface. Every page now has a single card in the middle,
  in a light and a dark theme that follows the system until a visitor picks one.
  Instance controls (language, theme) move to the footer.
- Creating a note:
  - The password generator is a tool of the note, not a separate tab: it puts
    the password where the caret is. A note made of the generated password
    alone still reaches the reader as a password to copy.
  - Markdown is a "Formatting" toggle.
  - Files are attached from the toolbar or dropped onto the note.
  - Expiry, reads and the opening password read as one sentence under the
    note, and the note field has focus on arrival (keyboard and mouse only).
- Password managers no longer fill the opening password with saved
  credentials.
- Opening a note shows the reads it has left, and says so before the last one
  is spent. A single-read note opens in one click, its warning next to the
  button. After a wrong password the page says that the attempt spent a read,
  and how many are left.
- A link whose key is missing or cut short is caught before it spends a read.
  Pasting the full link into the same tab opens the note.
- Deleting a note asks for confirmation in the page, not in a browser dialog.
- Motion stops within five seconds (WCAG 2.2.2): the accent arc turns once when
  a card appears and once each time it takes the focus, and the glow settles
  once. Only the progress card keeps turning while it works. Nothing moves
  under `prefers-reduced-motion`.
- Accessibility:
  - Text and controls reach WCAG AA contrast in both themes, whatever
    `APP_PRIMARY_COLOR` is.
  - The focus is visible everywhere, and forced-colors mode keeps controls
    outlined.
  - Screen readers hear the progress steps, the copy confirmations, and a
    generated password as one string.
- Sizes follow the reader's language ("2,5 Mo", "2.5 MB"), counts use each
  language's plural forms, and the translations were reviewed in all ten
  languages.
- The QR code carries the instance's accent and a logo, drawn at error
  correction level H so the logo costs nothing to readers.
- The default accent is indigo instead of red. `APP_PRIMARY_COLOR` still sets
  it, and also derives the gradients and the dark-theme shade.

### Added

- `GET /api/v1/notes/:id/exists` also returns `readCount`, the reads a note has
  already spent, so a client can say how many are left before opening it. It
  stays at 0 on a note without a read limit. The SDK reads it from 1.2.0.

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

[Unreleased]: https://github.com/largerio/secret/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/largerio/secret/releases/tag/v1.5.0
[1.4.1]: https://github.com/largerio/secret/releases/tag/v1.4.1
[1.4.0]: https://github.com/largerio/secret/releases/tag/v1.4.0
[1.3.2]: https://github.com/largerio/secret/releases/tag/v1.3.2
[1.3.1]: https://github.com/largerio/secret/releases/tag/v1.3.1
[1.3.0]: https://github.com/largerio/secret/releases/tag/v1.3.0
[1.2.1]: https://github.com/largerio/secret/releases/tag/v1.2.1
[1.2.0]: https://github.com/largerio/secret/releases/tag/v1.2.0
[1.1.0]: https://github.com/largerio/secret/releases/tag/v1.1.0
[1.0.0]: https://github.com/largerio/secret/releases/tag/v1.0.0
