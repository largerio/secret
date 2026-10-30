# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Secret, please report it privately via [GitHub Security Advisories](https://github.com/largerio/secret/security/advisories/new).

**Do not open a public issue for security vulnerabilities.**

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

The following are in scope:

- Authentication bypass (PoW, API keys)
- Encryption/decryption flaws (key leakage, nonce reuse, plaintext exposure)
- Server-side access to plaintext content (zero-knowledge violation)
- SQL injection, path traversal, SSRF
- XSS, CSRF, header injection
- Rate limit bypass
- Information disclosure via error messages or timing side-channels

## Architecture Overview

Secret uses a double-encryption model:

1. **Client-side**: XChaCha20-Poly1305 (libsodium) with keys derived via Argon2id
2. **Server-side**: AES-256-GCM (Node.js crypto) at rest, as an extra layer — see [what it covers](#what-the-server-can-see)

The decryption key is stored in the URL fragment (`#key`), which browsers never send to the server. The server never has access to plaintext content.

[PROTOCOL.md](PROTOCOL.md) specifies the format: the keys, both note formats, what the server learns, and the limits of format 0.

## What the Server Can See

Zero-knowledge covers the content, not the metadata. This is what the operator,
or anyone holding the server's database and storage, can and cannot learn:

| Data | Visible to the server |
|------|-----------------------|
| Text, file contents, file names and types | No — encrypted in the browser before upload |
| Decryption key and password | No — the key stays in the URL fragment, the password never leaves the browser |
| Size | Its size class only, for a [format 1](PROTOCOL.md#format-1) note: the content is padded to at least 4 KiB, and above that to at most 6.25% over its size (3.125% from 64 KiB), so every note up to 4 KiB has the same size. A format 0 note, written by the app up to 1.5 or the SDK up to 1.2, is not padded: it gives the size of the content to within a few bytes, and a chunked upload each file's size |
| Number of files, password set or not, read limit and reads so far, expiry, creation time | Yes — stored in clear to enforce them |
| For a [format 1](PROTOCOL.md#format-1) note: its envelope, and how many wrong passwords were tried | Yes — the envelope holds nothing derived from the key or the password; what checks a reader's proofs is kept under `SERVER_ENCRYPTION_KEY` |
| When a note is created, read and deleted | Yes |
| IP addresses | Seen for rate limiting and kept in memory for about a minute; never written to the app's logs. Your reverse proxy may log them |
| Note IDs | Never written to the app's logs |

The at-rest layer uses `SERVER_ENCRYPTION_KEY`. Left empty, that key is generated
on first start and stored in the data volume (`.encryption_key`), so a copy of the
volume, or of a backup of it, holds both the key and the data: the layer then only
protects a leaked database or S3 bucket on its own. To cover a stolen volume too,
set `SERVER_ENCRYPTION_KEY` from a secret store, or mount it as a file named by
`SERVER_ENCRYPTION_KEY_FILE`, and keep it out of the volume and its backups. Either way, the content stays protected by the end-to-end layer.

## Security Measures

- Timing-safe token comparison (`crypto.timingSafeEqual`)
- Key buffers zeroed after use (`sodium.memzero`) — a best effort: JavaScript
  strings and libsodium's internal WASM copies are not wiped
- Strict Content Security Policy (CSP)
- Per-IP rate limiting on all endpoints
- Zod validation on all inputs with max length constraints
- `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` on file downloads
- SQLite `secure_delete` and WAL mode
- Non-root Docker container with read-only filesystem
- Signed images: a keyless cosign signature and a SLSA build provenance
  attestation from the workflow that built them
  ([how to verify](docs/self-hosting.md#verifying-the-image))
- No logging of note content, decryption keys, note IDs or IP addresses

## Threat Model

**What Secret protects against**

- **A curious or compromised server operator.** The server stores only doubly
  encrypted blobs. The client-side key lives in the URL fragment (`#key`) and is
  never transmitted, so a full database/disk compromise does not reveal plaintext.
- **A network observer.** With HTTPS terminated at the reverse proxy (see
  Assumptions), traffic is encrypted in transit; the fragment is never sent on the
  wire at all.
- **Automated write abuse.** Browser writes require a proof-of-work token (Cap);
  SDK writes require an API key. Reads need no account, but a format 1 note is
  served only to a reader who proves they hold the link, and the password of a
  password note: the note's ID alone neither reads it nor burns it, a wrong
  password spends no read, and the fifth deletes the note.
- **Tampering / forgery.** Both encryption layers are authenticated (AEAD), so any
  modification of stored ciphertext is detected on decryption and surfaced as a
  single, cause-hiding error (no decryption oracle).

**Out of scope / explicit non-goals**

- **Anyone who has the full share link** (including the `#key`) can read the note —
  this is by design. Protect the link; optionally add a password.
- **A compromised client** (malicious browser extension, XSS in an embedding page,
  a backdoored build of the web app) can read plaintext, since decryption happens
  in the browser. Integrity of the delivered JavaScript is assumed (see Assumptions).
- **Endpoint security of sender/recipient** (keyloggers, shoulder-surfing, clipboard
  scrapers) is the user's responsibility.
- **Traffic-analysis / metadata correlation** at the network layer.

## Assumptions

- **TLS is terminated at the reverse proxy.** The app server speaks plain HTTP
  behind a proxy that enforces HTTPS; HSTS is advertised by the app. Deploying the
  app server directly on the public internet without TLS breaks the in-transit
  guarantees.
- **The server never sees plaintext.** This holds only as long as the double-encryption
  layers and the URL-fragment key model are kept intact (removing either is a
  security-model change).
- **The delivered web app and its dependencies are trusted.** Zero-knowledge relies
  on the integrity of the JavaScript served to the browser and the build/supply chain.
- **`SERVER_ENCRYPTION_KEY` is kept secret** and is backed up out-of-band.

## Known Limitations

- **Metadata enumeration via `GET /api/v1/notes/:id/exists`.** This endpoint reveals
  whether a note ID exists and exposes coarse metadata (`hasPassword`, `fileCount`,
  `chunked`, expiry, the configured read limit and the reads already spent against
  it) without authentication, to anyone who knows the note ID — no key needed. Anyone
  with the ID can therefore watch the reads of a multi-read note being spent, without
  spending one; a burn-after-read note already gave that away by disappearing. An
  unlimited note always reports 0 reads, so the endpoint is not a view counter. For a
  format 1 note it also serves the envelope (the salt and the Argon2id parameters a
  reader needs, and the expiry chosen, which gives the creation time to the second)
  and the password attempts left, so anyone with the ID can see wrong passwords
  being tried. It is
  rate-limited but is not zero-knowledge with respect to existence/metadata. Note IDs are long and
  random, so enumeration is impractical, but the leak is acknowledged.
- **One instance only.** SQLite, the proof-of-work challenges and the rate-limit
  counters all live in a single process, and none of them can be shared. Run exactly
  one replica (on Kubernetes: `replicas: 1`, the `Recreate` strategy and a
  `ReadWriteOnce` volume). A second replica would reject the proof-of-work tokens
  issued by the first and split every rate limit in two.
- **`SERVER_ENCRYPTION_KEY` is not rotatable.** It is mixed into every stored note;
  changing it renders all existing notes permanently undecryptable. There is no
  re-encryption/rotation path today.
- **Proof-of-work is best-effort.** Cap raises the cost of automated writes but does
  not stop a determined attacker willing to spend CPU. Tune `CAP_DIFFICULTY` /
  `CAP_CHALLENGE_COUNT` upward under sustained abuse.
- **No forward secrecy across a leaked link.** Because the key is the link, anyone
  who ever captured the link can decrypt the note until it expires or is deleted.

## Supported Versions

Fixes ship in new 1.x releases; older releases are not patched. Run `:1`: it
follows every 1.x release and picks up base-image (OS and Node) fixes between
releases. An exact tag such as `:1.3.2` never changes, so it gets neither. See
[Pinning a version](README.md#pinning-a-version) for every tag, and
[CHANGELOG.md](CHANGELOG.md) for what each release changes.

The SDK (`@largerio/secret-sdk`) is supported in its latest 1.x version.
