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
2. **Server-side**: AES-256-GCM (Node.js crypto) as defense-in-depth

The decryption key is stored in the URL fragment (`#key`), which browsers never send to the server. The server never has access to plaintext content.

## Security Measures

- Timing-safe token comparison (`crypto.timingSafeEqual`)
- Key memory zeroing after use (`sodium.memzero`)
- Strict Content Security Policy (CSP)
- Per-IP rate limiting on all endpoints
- Zod validation on all inputs with max length constraints
- `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` on file downloads
- SQLite `secure_delete` and WAL mode
- Non-root Docker container with read-only filesystem
- No logging of note content, IPs, or user data

## Threat Model

**What Secret protects against**

- **A curious or compromised server operator.** The server stores only doubly
  encrypted blobs. The client-side key lives in the URL fragment (`#key`) and is
  never transmitted, so a full database/disk compromise does not reveal plaintext.
- **A network observer.** With HTTPS terminated at the reverse proxy (see
  Assumptions), traffic is encrypted in transit; the fragment is never sent on the
  wire at all.
- **Automated write abuse.** Browser writes require a proof-of-work token (Cap);
  SDK writes require an API key. Reads are intentionally open.
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
  `chunked`, expiry, remaining reads) without authentication. It is rate-limited but
  is not zero-knowledge with respect to existence/metadata. Note IDs are long and
  random, so enumeration is impractical, but the leak is acknowledged.
- **In-memory rate limiting is single-instance.** Counters live in process memory,
  so limits are per-replica. Running multiple instances behind a load balancer
  weakens the global rate limit; use a shared store or sticky routing if you scale out.
- **`SERVER_ENCRYPTION_KEY` is not rotatable.** It is mixed into every stored note;
  changing it renders all existing notes permanently undecryptable. There is no
  re-encryption/rotation path today.
- **Proof-of-work is best-effort.** Cap raises the cost of automated writes but does
  not stop a determined attacker willing to spend CPU. Tune `CAP_DIFFICULTY` /
  `CAP_CHALLENGE_COUNT` upward under sustained abuse.
- **No forward secrecy across a leaked link.** Because the key is the link, anyone
  who ever captured the link can decrypt the note until it expires or is deleted.

## Supported Versions

Only the latest version is supported with security updates.
