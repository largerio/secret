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
- SQLite `secure_delete` and WAL mode
- Non-root Docker container with read-only filesystem
- No logging of note content, IPs, or user data

## Supported Versions

Only the latest version is supported with security updates.
