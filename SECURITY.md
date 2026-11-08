# Security policy

## Reporting a vulnerability

If you find a security vulnerability in Secret, please report it privately
through [GitHub Security Advisories](https://github.com/largerio/secret/security/advisories/new).

**Please don't open a public issue for a vulnerability.**

We acknowledge reports within 48 hours, and aim to release a fix within 7
days for critical issues.

## Supported versions

Fixes ship in new 1.x releases; older releases are not patched. Run `:1`: it
follows every 1.x release and picks up base-image (OS and Node) fixes between
releases. An exact tag such as `:1.8.0` never changes, so it gets neither. See
[Pinning a version](docs/self-hosting.md#pinning-a-version) for every tag,
and [CHANGELOG.md](CHANGELOG.md) for what each release changes.

The SDK (`@largerio/secret-sdk`) is supported in its latest 1.x version, and
the command line (`@largerio/secret-cli`) in its latest version.

## Scope

In scope:

- Authentication bypass (proof of work, API keys)
- Encryption and decryption flaws (key leakage, nonce reuse, plaintext exposure)
- Server-side access to plaintext content (a zero-knowledge violation)
- SQL injection, path traversal, SSRF
- XSS, CSRF, header injection
- Rate limit bypass
- Information disclosure through error messages or timing side channels
- The command line (`@largerio/secret-cli`): a received file written outside
  its directory or over another file, a note driving the terminal, a link or
  key leaked to stderr

## Architecture overview

Secret encrypts twice:

1. **In the client**: XChaCha20-Poly1305 (libsodium), under a random key that
   the link carries. With a password, the key also depends on it, through
   Argon2id.
2. **On the server**: AES-256-GCM (Node.js crypto) at rest, as an extra
   layer. See [what it covers](#what-the-server-can-see).

The key is in the URL fragment (`#key`), which browsers never send to the
server. The server never has access to the plaintext.

[PROTOCOL.md](PROTOCOL.md) specifies the format: the keys, both note formats,
what the server learns, and the limits of format 0.

## What the server can see

Zero-knowledge covers the content, not the metadata. This is what the
operator, or anyone holding the server's database and storage, can and can't
learn:

| Data | Visible to the server |
|------|-----------------------|
| Text, file contents, file names and types | No: encrypted in the browser before upload |
| Decryption key and password | No: the key stays in the URL fragment, the password never leaves the browser |
| Size | Only its size class, for a [format 1](PROTOCOL.md#format-1) note: the content is padded to 4 KiB at least, and above that to at most 6.25% over its size (3.125% from 64 KiB), so every note up to 4 KiB has the same size. A [format 0](PROTOCOL.md#format-0-legacy) note, the legacy format, is not padded: it gives the size of the content to within a few bytes, and a chunked upload each file's size |
| Number of files, password set or not, read limit and reads so far, expiry, creation time | Yes: stored in clear to enforce them |
| For a [format 1](PROTOCOL.md#format-1) note: its envelope, and how many wrong passwords were tried | Yes. The envelope holds nothing derived from the key or the password; what checks a reader's proofs is kept under `SERVER_ENCRYPTION_KEY` |
| When a note is created, read and deleted | Yes |
| IP addresses | Seen for rate limiting and kept in memory for about a minute; never written to the app's logs. Your reverse proxy may log them |
| Note IDs | Never written to the app's logs |

The at-rest layer uses `SERVER_ENCRYPTION_KEY`. Left empty, that key is
generated on the first start and stored in the data volume
(`.encryption_key`), so a copy of the volume, or of a backup of it, holds
both the key and the data: the layer then only protects a leaked database or
S3 bucket on its own. To cover a stolen volume too, set
`SERVER_ENCRYPTION_KEY` from a secret store, or mount it as a file named by
`SERVER_ENCRYPTION_KEY_FILE`, and keep it out of the volume and its backups.
Either way, the content stays protected by the end-to-end layer.

## Security measures

| Layer | Details |
|-------|---------|
| Client encryption | XChaCha20-Poly1305 (192-bit nonce, AEAD) |
| Server encryption | AES-256-GCM at rest, bound to the note ID |
| Password | Argon2id (256 MiB, 3 iterations, libsodium's `MODERATE`) |
| Read proof | A note is served only to a reader who proves they hold the link, and the password of a password note; five wrong passwords delete it |
| Padding | Padmé size classes, 4 KiB at least: at most 6.25% over the content |
| Write authentication | A proof of work (Cap, SHA-256) or an API key |
| Token comparison | Timing-safe (`crypto.timingSafeEqual`) |
| Key hygiene | Key buffers zeroed after use (`sodium.memzero`), as a best effort: JavaScript strings and libsodium's internal WASM copies are not wiped. The key also lives in the URL, the browser's history and the clipboard, as the link-carries-the-key model implies |
| HTTP | A strict Content Security Policy (scripts from the instance alone, its inline ones allowed by their hash, no framing), HSTS (preload), Permissions-Policy, per-IP rate limits on every endpoint |
| Downloads | `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` |
| Input | Zod schemas with length limits on every input; path traversal protection and S3 key validation in storage |
| Database | SQLite `secure_delete`, WAL mode |
| Privacy | No analytics. No note content, decryption keys, note IDs or IP addresses in the logs. Two first-party preference cookies (language, theme) |
| Container | Non-root, read-only filesystem, dropped capabilities |
| Image provenance | Signed (cosign, keyless) with a SLSA build provenance attestation, once scanned and smoke-tested ([how to verify](docs/self-hosting.md#verifying-the-image)) |
| Web app integrity | A reproducible static bundle: each release publishes its digest, which `/api/health` reports ([how to verify](#verifying-the-web-app)) |

## Threat model

**What Secret protects against**

- **A curious or compromised server operator.** The server stores only doubly
  encrypted blobs. The client-side key lives in the URL fragment (`#key`) and
  is never sent, so a full database or disk compromise does not reveal
  plaintext.
- **A network observer.** With HTTPS terminated at the reverse proxy (see
  [Assumptions](#assumptions)), traffic is encrypted in transit, and the
  fragment is never sent on the wire at all.
- **Automated write abuse.** Every write needs a proof-of-work token (Cap),
  which the browser and the command line solve, or an API key, which scripts
  and the SDK usually use. Reads need no account, but a format 1 note is
  served only to a reader who proves they hold the link, and the password of
  a password note: the note's ID alone neither reads it nor burns it, a wrong
  password spends no read, and the fifth deletes the note.
- **Tampering and forgery.** Both encryption layers are authenticated (AEAD),
  so any change to the stored ciphertext is detected on decryption, and
  surfaces as a single error that hides its cause (no decryption oracle).

**Out of scope**

- **Anyone who has the full share link** (including the `#key`) can read the
  note. That's by design: protect the link, and add a password if needed.
- **A compromised client** (a malicious browser extension, XSS in an
  embedding page, a backdoored build of the web app) can read the plaintext,
  since decryption happens in the browser. The integrity of the JavaScript
  delivered is assumed (see [Assumptions](#assumptions));
  [it can be checked](#verifying-the-web-app).
- **The security of the sender's and recipient's devices** (keyloggers,
  shoulder-surfing, clipboard scrapers) is up to them.
- **Traffic analysis** and metadata correlation at the network layer.

## Assumptions

- **TLS is terminated at the reverse proxy.** The app speaks plain HTTP behind
  a proxy that enforces HTTPS; the app sends HSTS. Exposing the app directly
  on the internet without TLS breaks the in-transit guarantees.
- **The server never sees plaintext.** This holds only as long as both
  encryption layers and the key-in-the-fragment model are kept intact.
  Removing either is a change to the security model.
- **The delivered web app and its dependencies are trusted.** Zero-knowledge
  relies on the integrity of the JavaScript served to the browser, and of the
  build and supply chain. Anyone can check what an instance serves them
  against a release: see [Verifying the web app](#verifying-the-web-app).
- **`SERVER_ENCRYPTION_KEY` is kept secret**, and backed up out of band.

## Verifying the web app

End-to-end encryption on the web has one weak point: the JavaScript that does
it comes from the server. An instance that served a modified web app could
read what a visitor types before it's encrypted, and the key of every link
they open. A signed image doesn't help the visitor, who never sees the image,
only what the instance serves. What can be checked is what the instance
answers you: whether the pages and files you fetch are those of a release,
and would run its code and no other.

**The digest.** The web app is a static bundle, and its build writes
`bundle.json` at its root: the SHA-256 of every other file in it, and a
digest over them all, `sha256:<hex>`. The build is reproducible: the same
sources give the same digest wherever they're built. CI checks it on every
change, by building the web app in the image (Alpine) and outside it
(Ubuntu). The release workflow reads the digest from the image it releases,
and the release notes give it.

**What an instance says it serves.** `/api/health` reports
`"bundle": "sha256:<hex>"`, the digest of the files the instance serves,
which it computes from them when it starts. `/bundle.json` serves the
manifest: every file, its size and its SHA-256. Both come from the instance,
which could lie in them: they give you something to compare with the release
notes, and with your own build.

**Checking an instance.** From a checkout of the release's tag, build the web
app with Node 26 and pnpm, then run `scripts/verify-web-app.sh` with the
instance's address (its `APP_URL`) and the digest the release notes give:

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

It needs bash, coreutils, curl and Node. It says what differs, if anything,
and exits with 1 when something does. Without the release's digest, it
prints the build's, for you to compare with the release notes;
`scripts/verify-web-app.sh --digest-of apps/web/build` prints it alone. CI
runs it on every change, against the image it builds. It checks:

- **The build**: its files make the digest its `bundle.json` names, so
  nothing touched them since the build, and that digest is the release's.
- **What the instance reports**: `/api/health` gives the same digest.
- **The files**: every file of the build but the shell, `bundle.json`
  included, is served at its path, compressed as a browser asks for it, and
  hashes as yours does.
- **The shell.** Every page is the shell, `index.html`, which the instance
  fills in for each request: the visitor's language, theme and accent, the
  page's title and meta tags, and the instance's settings for the page to
  start from. Its bytes aren't the build's, so the script checks what it may
  run instead, on the home page, a note's page, a note's deletion page and an
  unknown one:
  - Every address it names, in an attribute or in its boot script, must be a
    file of the build. Otherwise a script it loaded from the instance could
    be any script, since its policy lets the page run any of the instance's.
    The only other address allowed is the instance's own, in links that load
    nothing. It may hold no `<meta http-equiv="refresh">` and no `srcset`,
    which the release's shell never has.
  - Its `Content-Security-Policy` header must let it run the instance's files
    and the build's inline scripts, and nothing else: `script-src` must be
    `'self' 'wasm-unsafe-eval'` followed by the SHA-256 of each inline script
    of the build's `index.html` that a browser runs, and no
    `script-src-elem` or `script-src-attr` may take its place.

With both, the page runs the build's boot script and the files it names,
which you compared, and those load only files of the build. An inline script
added to the page has no hash in the policy, so the browser doesn't run it.
The digest the script recomputes is the one `packages/shared/src/bundle.ts`
specifies, which coreutils alone can compute.

**What this proves.** That the responses you fetched, when you fetched them,
were the release's files, and a page that runs the release's code alone. Not
that the instance answers a browser the same way, nor another visitor, nor
later: an instance can tell its visitors apart, and serve a modified web app
to some of them only. A check tells an instance that runs a release from one
that doesn't, for whoever checks. Whoever runs the instance is still someone
its visitors trust.

## Known limitations

- **Decrypted files on the reader's device.** So that a large note never has
  to fit in memory, the web app decrypts a note's files into the browser's
  private storage for the site (the origin private file system), which only
  the instance's own pages can reach, and previews and downloads them from
  there. They're deleted when the page lets go of the note: when the reader
  leaves or closes it, or, if a tab crashed or was closed first, when the
  next page of the instance opens in that browser. Until then they're on the
  device's disk, in the browser's profile, as a downloaded file would be.
  Where that storage is missing (a private window, an instance served over
  plain HTTP) or short of room, a file stays in memory instead.
- **Metadata through `GET /api/v1/notes/:id/exists`.** This endpoint tells
  anyone who knows a note's ID, without the key, whether the note exists, and
  its coarse metadata: `hasPassword`, `fileCount`, `chunked`, the expiry, the
  read limit and the reads already spent. Anyone with the ID can therefore
  watch the reads of a multi-read note being spent, without spending one; a
  burn-after-read note gives that away anyway by disappearing. An unlimited
  note always reports 0 reads, so the endpoint isn't a view counter. For a
  format 1 note it also serves the envelope (the salt, the Argon2id
  parameters, and the expiry chosen, which gives the creation time to the
  second) and the password attempts left, so anyone with the ID can see wrong
  passwords being tried. It's rate-limited, and note IDs are long and random,
  so enumeration is impractical, but the leak is acknowledged.
- **One instance only.** SQLite, the proof-of-work challenges and the
  rate-limit counters all live in a single process, and none of them can be
  shared. Run exactly one replica (on Kubernetes: `replicas: 1`, the
  `Recreate` strategy and a `ReadWriteOnce` volume). A second replica would
  reject the proof-of-work tokens issued by the first, and split every rate
  limit in two.
- **`SERVER_ENCRYPTION_KEY` can't be rotated.** It's mixed into every stored
  note: changing it makes every existing note permanently unreadable. There
  is no re-encryption path.
- **The proof of work is best effort.** Cap raises the cost of automated
  writes but doesn't stop an attacker willing to spend CPU: the command line
  solves it in a few seconds at the default difficulty. Raise
  `CAP_DIFFICULTY` or `CAP_CHALLENGE_COUNT` under sustained abuse.
- **No forward secrecy for a leaked link.** Since the key is the link, anyone
  who ever captured the link can decrypt the note until it expires or is
  deleted.

## The command line

`@largerio/secret-cli` encrypts and decrypts in its own process, with the
SDK: an instance learns from it what it learns from the web app. Besides:

- **Received files** are written only directly inside the directory the
  reader names, under a name made safe (no path, no control or bidirectional
  characters, no leading dot or dash, no Windows device name), never over a
  file, directory or link already there, and only once the whole note is
  verified. Until then they're `.part` files, created exclusively with mode
  `0600`, and removed if the note is refused or the read interrupted. Their
  contents come from the sender and aren't inspected.
- **The terminal.** On a terminal, a note's text, and anything else the
  sender or the instance wrote, has its control characters (C0 except line
  feed and tab, DEL, C1) and invisible format characters replaced before
  it's shown, so a note can't drive the terminal. Output redirected to a file
  or a program is the text byte for byte, escape sequences included: whatever
  reads it must not trust it.
- **Secrets in arguments.** No option takes the text, an API key or a
  password, and the link is printed on stdout only, never on stderr or in an
  error. `read` takes the link on stdin or at a prompt without echo, and
  `check` and `delete` need only the note's ID. A link given as an argument
  anyway stays in the shell's history and shows in `ps`: the command can't
  take it back. `SECRET_API_KEY` and `SECRET_PASSWORD` are visible to the
  user's own processes, as any environment variable is; `SECRET_API_KEY_FILE`
  and `--password-file` keep them in files instead.
- **`http:`.** An API key isn't sent over plain HTTP to a host other than the
  loopback, unless `--allow-http` says so. A note sent or read over `http:`
  stays end-to-end encrypted, but whoever is on the path sees the requests, a
  format 1 read's proofs among them, and can answer in the instance's place.
