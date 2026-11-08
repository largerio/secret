# Security policy

## Reporting a vulnerability

If you find a security vulnerability in Secret, please report it privately
through [GitHub Security Advisories](https://github.com/largerio/secret/security/advisories/new).
Please don't open a public issue.

We acknowledge reports within 48 hours, and aim to ship a fix for critical
issues within 7 days.

## Supported versions

Fixes ship in new 1.x releases, and older releases aren't patched. Run the
`:1` tag: it follows every 1.x release, and picks up fixes to the base image
(OS and Node) between releases. An exact tag such as `:1.8.0` never changes,
so it gets neither. [Pinning a version](docs/self-hosting.md#pinning-a-version)
lists every tag, and [CHANGELOG.md](CHANGELOG.md) what each release changes.

For the SDK (`@largerio/secret-sdk`), the latest 1.x version is supported.
For the command line (`@largerio/secret-cli`), the latest version is.

## Scope

In scope:

- Authentication bypass (proof of work, API keys)
- Encryption and decryption flaws (key leakage, nonce reuse, plaintext
  exposure)
- Server-side access to plaintext content, which breaks zero-knowledge
- SQL injection, path traversal, SSRF
- XSS, CSRF, header injection
- Rate limit bypass
- Information disclosure through error messages or timing side channels
- In the command line (`@largerio/secret-cli`): a received file written
  outside its directory or over another file, a note that takes control of
  the terminal, a link or key leaked to stderr

## Architecture overview

Secret encrypts every note twice:

1. **In the client**, with XChaCha20-Poly1305 (libsodium), under a random
   key carried by the link. With a password, the key also depends on the
   password, through Argon2id.
2. **On the server**, with AES-256-GCM (Node.js crypto) at rest, as an extra
   layer. See [what it covers](#what-the-server-can-see).

The key sits in the URL fragment (`#key`), which browsers never send to the
server, so the server never has access to the plaintext.

[PROTOCOL.md](PROTOCOL.md) specifies the format: the keys, both note formats,
what the server learns, and the limits of the legacy format.

## What the server can see

Zero-knowledge covers the content, not the metadata. Here is what the
operator, or anyone who gets hold of the server's database and storage, can
and can't learn:

| Data | Visible to the server? |
|------|------------------------|
| Text, file contents, file names and types | No. They're encrypted in the browser before upload |
| Decryption key and password | No. The key stays in the URL fragment, and the password never leaves the browser |
| Size | Only the size class of a [format 1](PROTOCOL.md#format-1) note. The content is padded to at least 4 KiB, and above that to at most 6.25% over its size (3.125% from 64 KiB), so every note up to 4 KiB looks the same size. A [format 0](PROTOCOL.md#format-0-legacy) note, the legacy format, isn't padded: it reveals the size of its content to within a few bytes, and a chunked upload reveals each file's size |
| Number of files, whether there's a password, read limit and reads so far, expiry, creation time | Yes. They're stored in clear so that the server can enforce them |
| For a [format 1](PROTOCOL.md#format-1) note: its envelope, and how many wrong passwords were tried | Yes. The envelope holds nothing derived from the key or the password, and what checks a reader's proofs is kept under `SERVER_ENCRYPTION_KEY` |
| When a note is created, read and deleted | Yes |
| IP addresses | Seen for rate limiting and kept in memory for about a minute, but never written to the app's logs. Your reverse proxy may log them, though |
| Note IDs | Never written to the app's logs |

The at-rest layer uses `SERVER_ENCRYPTION_KEY`. If you leave it empty, the
key is generated on the first start and stored in the data volume
(`.encryption_key`). A copy of the volume, or of a backup of it, then holds
both the key and the data, so on its own the layer only protects a leaked
database or S3 bucket.

To cover a stolen volume too, set `SERVER_ENCRYPTION_KEY` from a secret
store, or mount it as a file named by `SERVER_ENCRYPTION_KEY_FILE`, and keep
it out of the volume and its backups. Either way, the content stays
protected by the end-to-end layer.

## Security measures

| Layer | Details |
|-------|---------|
| Client encryption | XChaCha20-Poly1305 (192-bit nonce, AEAD) |
| Server encryption | AES-256-GCM at rest, bound to the note ID |
| Password | Argon2id (256 MiB, 3 iterations, libsodium's `MODERATE`) |
| Read proof | A note is only served to a reader who proves they hold the link, and the password if there is one. Five wrong passwords delete it |
| Padding | Padmé size classes, 4 KiB at least, at most 6.25% over the content |
| Write authentication | A proof of work (Cap, SHA-256) or an API key |
| Token comparison | Constant time (`crypto.timingSafeEqual`) |
| Key hygiene | Key buffers are zeroed after use (`sodium.memzero`), as a best effort: JavaScript strings and libsodium's internal WASM copies aren't wiped. The key also lives in the URL, the browser's history and the clipboard, which comes with putting the key in the link |
| HTTP | A strict Content Security Policy (scripts from the instance only, its inline scripts allowed by hash, no framing), HSTS with preload, Permissions-Policy, and per-IP rate limits on every endpoint |
| Downloads | `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` |
| Input | Zod schemas with length limits on every input, path traversal protection and S3 key validation in storage |
| Database | SQLite `secure_delete`, WAL mode |
| Privacy | No analytics. No note content, decryption keys, note IDs or IP addresses in the logs. Two first-party preference cookies (language, theme) |
| Container | Non-root, read-only filesystem, dropped capabilities |
| Image provenance | Signed (cosign, keyless) with a SLSA build provenance attestation, once scanned and smoke-tested ([how to verify](docs/self-hosting.md#verifying-the-image)) |
| Web app integrity | A reproducible static bundle: each release publishes its digest, which `/api/health` reports ([how to verify](#verifying-the-web-app)) |

## Threat model

**What Secret protects against**

- **A curious or compromised server operator.** The server only stores
  doubly encrypted blobs. The client's key lives in the URL fragment and is
  never sent, so even a full database or disk compromise reveals no
  plaintext.
- **A network observer.** With HTTPS terminated at the reverse proxy (see
  [Assumptions](#assumptions)), traffic is encrypted in transit, and the
  fragment never goes over the wire at all.
- **Automated write abuse.** Every write needs either a proof-of-work token
  (Cap), which the browser and the command line solve, or an API key, which
  scripts and the SDK usually use. Reading needs no account, but a format 1
  note is only served to a reader who proves they hold the link, and the
  password if there is one. Knowing a note's ID isn't enough to read it or
  burn it, a wrong password spends no read, and the fifth wrong password
  deletes the note.
- **Tampering and forgery.** Both encryption layers are authenticated
  (AEAD), so any change to the stored ciphertext is caught on decryption. It
  surfaces as a single error that doesn't say why, so there's no decryption
  oracle.

**Out of scope**

- **Anyone with the full link**, `#key` included, can read the note. That's
  by design: protect the link, and add a password if you need to.
- **A compromised client**, such as a malicious browser extension, XSS in a
  page that embeds the client, or a backdoored build of the web app, can
  read the plaintext, since decryption happens in the browser. We assume the
  JavaScript delivered is intact (see [Assumptions](#assumptions)), and
  [you can check it](#verifying-the-web-app).
- **The sender's and recipient's devices** (keyloggers, shoulder-surfing,
  clipboard scrapers) are their own responsibility.
- **Traffic analysis** and metadata correlation at the network layer.

## Assumptions

- **TLS is terminated at the reverse proxy.** The app speaks plain HTTP
  behind a proxy that enforces HTTPS, and sends HSTS. Exposing the app
  directly to the internet without TLS breaks the in-transit guarantees.
- **The server never sees plaintext**, as long as both encryption layers and
  the key-in-the-fragment model stay intact. Removing either is a change to
  the security model.
- **The web app and its dependencies are trusted.** Zero-knowledge relies on
  the integrity of the JavaScript served to the browser, and of the build and
  supply chain behind it. Anyone can check what an instance serves them
  against a release: see [Verifying the web app](#verifying-the-web-app).
- **`SERVER_ENCRYPTION_KEY` is kept secret**, and backed up separately.

## Verifying the web app

End-to-end encryption on the web has one weak spot: the JavaScript that does
the encrypting comes from the server. An instance that served a modified web
app could read what visitors type before it's encrypted, along with the key
of every link they open. A signed image doesn't help visitors: they never see
the image, only what the instance serves them. What you can check is what the
instance actually answers: whether the pages and files you get are those of a
release, and would run its code and nothing else.

**The digest.** The web app is a static bundle. Its build writes
`bundle.json` at the root, with the SHA-256 of every other file and a digest
over all of them, `sha256:<hex>`. The build is reproducible, so the same
sources give the same digest wherever they're built. CI checks this on every
change, by building the web app both inside the image (Alpine) and outside it
(Ubuntu). The release workflow reads the digest from the image it releases,
and the release notes publish it.

**What an instance says it serves.** `/api/health` reports
`"bundle": "sha256:<hex>"`, the digest of the files the instance serves,
computed from those files when it starts. `/bundle.json` serves the
manifest: every file, with its size and SHA-256. Both come from the
instance, which could lie about them. They give you something to compare
with the release notes and with your own build.

**Checking an instance.** Check out the release's tag, build the web app
with Node 26 and pnpm, then run `scripts/verify-web-app.sh` with the
instance's address (its `APP_URL`) and the digest from the release notes:

```bash
TAG=vX.Y.Z   # the release to check
git clone --depth 1 --branch "$TAG" https://github.com/largerio/secret.git
cd secret
# Node 25 and later ship no corepack: install the image's version.
npm install -g corepack@0.35.0 && corepack enable
pnpm install --frozen-lockfile
pnpm --filter @largerio/web build
scripts/verify-web-app.sh https://secret.example.com sha256:<hex>
```

The script needs bash, coreutils, curl and Node. It reports anything that
differs, and exits with 1 if something does. Without the release's digest,
it prints the build's, for you to compare with the release notes yourself;
`scripts/verify-web-app.sh --digest-of apps/web/build` prints only that. CI
runs the script on every change, against the image it builds. It checks:

- **The build.** Its files add up to the digest in its `bundle.json`, so
  nothing has changed since the build, and that digest is the release's.
- **What the instance reports.** `/api/health` gives the same digest.
- **The files.** Every file of the build except the shell, `bundle.json`
  included, is served at its path, compressed the way a browser asks for it,
  and hashes the same as yours.
- **The shell.** Every page is the shell, `index.html`, which the instance
  fills in for each request: the visitor's language, theme and accent, the
  page's title and meta tags, and the instance's settings. Its bytes
  therefore differ from the build's, so the script checks what it can run
  instead, on the home page, a note's page, a note's deletion page and an
  unknown page:
  - Every address the shell names, in an attribute or in its boot script,
    must be a file of the build. Otherwise, a script it loads from the
    instance could be any script, since the page's policy allows any script
    from the instance. The only other address allowed is the instance's own,
    in links that load nothing. The shell may not contain
    `<meta http-equiv="refresh">` or `srcset`, which the release's shell
    never uses.
  - Its `Content-Security-Policy` header must allow the instance's files and
    the build's inline scripts, and nothing else. `script-src` must be
    `'self' 'wasm-unsafe-eval'` followed by the SHA-256 of each inline script
    in the build's `index.html` that a browser runs, and no `script-src-elem`
    or `script-src-attr` may override it.

Together, these mean the page runs the build's boot script and the files it
names, which you've compared, and those files only load other files of the
build. An inline script added to the page has no hash in the policy, so the
browser won't run it. The digest the script computes is the one specified in
`packages/shared/src/bundle.ts`, which coreutils alone can compute.

**What this proves.** That the responses you got, when you got them, were
the release's files, and a page that runs only the release's code. It
doesn't prove that the instance answers a browser the same way, or another
visitor, or later on: an instance can tell its visitors apart, and serve a
modified web app to only some of them. A check tells an instance running a
release from one that isn't, for whoever runs the check. Visitors still have
to trust whoever runs the instance.

## Known limitations

- **Decrypted files on the reader's device.** So that a large note never has
  to fit in memory, the web app decrypts a note's files into the browser's
  private storage for the site (the origin private file system), which only
  the instance's own pages can access. It previews and downloads them from
  there. The files are deleted when the page lets go of the note: when the
  reader leaves or closes it, or, if the tab crashed or was closed first, the
  next time a page of the instance opens in that browser. Until then they
  sit on the device's disk, in the browser's profile, just like a downloaded
  file. Where that storage is missing (a private window, an instance served
  over plain HTTP) or full, a file stays in memory instead.
- **Metadata through `GET /api/v1/notes/:id/exists`.** Anyone who knows a
  note's ID, without the key, can ask this endpoint whether the note exists,
  and get its coarse metadata: `hasPassword`, `fileCount`, `chunked`, the
  expiry, the read limit and the reads already spent. So anyone with the ID
  can watch the reads of a multi-read note being spent, without spending one
  themselves. (A burn-after-read note gives that away anyway, by
  disappearing.) An unlimited note always reports 0 reads, so the endpoint
  can't serve as a view counter. For a format 1 note, it also serves the
  envelope (the salt, the Argon2id parameters, and the chosen expiry, which
  gives away the creation time to the second) and the password attempts
  left, so anyone with the ID can see wrong passwords being tried. The
  endpoint is rate-limited, and note IDs are long and random, so enumerating
  them is impractical, but the leak is acknowledged.
- **One instance only.** SQLite, the proof-of-work challenges and the
  rate-limit counters all live in a single process, and none of them can be
  shared. Run exactly one replica (on Kubernetes: `replicas: 1`, the
  `Recreate` strategy and a `ReadWriteOnce` volume). A second replica would
  reject the proof-of-work tokens issued by the first, and split every rate
  limit in two.
- **`SERVER_ENCRYPTION_KEY` can't be rotated.** It's mixed into every stored
  note, so changing it makes every existing note permanently unreadable.
  There's no re-encryption path.
- **The proof of work only slows attackers down.** Cap raises the cost of
  automated writes, but won't stop an attacker willing to spend CPU: the
  command line solves it in a few seconds at the default difficulty. Raise
  `CAP_DIFFICULTY` or `CAP_CHALLENGE_COUNT` under sustained abuse.
- **No forward secrecy for a leaked link.** The key is the link, so anyone
  who ever captured the link can decrypt the note until it expires or is
  deleted.

## The command line

`@largerio/secret-cli` encrypts and decrypts in its own process, with the
SDK, so an instance learns exactly what it learns from the web app. On top
of that:

- **Received files** are only written directly inside the directory the
  reader names, and only once the whole note is verified. Their names are
  made safe: no path, no control or bidirectional characters, no leading dot
  or dash, no Windows device name. They never replace a file, directory or
  link that's already there. Until the note is verified, they're `.part`
  files, created exclusively with mode `0600`, and removed if the note is
  refused or the read is interrupted. Their contents come from the sender and
  aren't inspected.
- **The terminal.** On a terminal, a note's text, and anything else the
  sender or the instance wrote, has its control characters (C0 except line
  feed and tab, DEL, C1) and invisible format characters replaced before it's
  shown, so a note can't take control of the terminal. Output redirected to a
  file or a program is the text byte for byte, escape sequences included, so
  whatever reads it must not trust it.
- **Secrets in arguments.** No option takes the text, an API key or a
  password, and the link is only ever printed on stdout, never on stderr or
  in an error. `read` takes the link on stdin, or at a prompt without echo,
  and `check` and `delete` only need the note's ID. A link passed as an
  argument anyway stays in the shell's history and shows up in `ps`, and the
  command can't take that back. `SECRET_API_KEY` and `SECRET_PASSWORD` are
  visible to the user's own processes, like any environment variable;
  `SECRET_API_KEY_FILE` and `--password-file` keep them in files instead.
- **Plain `http:`.** An API key is never sent over plain HTTP to a host other
  than the loopback, unless `--allow-http` says so. A note sent or read over
  `http:` stays end-to-end encrypted, but anyone on the path sees the
  requests, a format 1 read's proofs included, and can answer in the
  instance's place.
