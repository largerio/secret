---
"@largerio/secret-sdk": minor
---

Fix the published package: the generated `.d.ts` imported `@largerio/secret-shared`, a private workspace package that is never published, so every TypeScript consumer got `TS2307` — including on the README example. The payload types are now declared in the SDK itself, with a compile-time contract test keeping them identical to the shared definitions.

Also in this release:

- **Added `SecretNetworkError`.** A failed fetch (DNS, offline, connection reset, CORS) escaped as a raw `TypeError`, so `instanceof SecretApiError` missed it and callers had no typed way to tell a transport failure from a rejection. The original error is available as `.cause`.
- **`NoteInfo` is now a discriminated union.** The API returns only `{exists: false}` for a missing note, so declaring the other fields as always-present made the type lie: reading `info.maxReads` on a missing note silently gave `undefined`. Narrow on `exists` first. `checkNote` also validates the response shape instead of casting it, and no longer has a dead 404 branch the API never takes.
- **`parseShareUrl` accepts relative URLs**, so it round-trips `buildShareUrl` under the default configuration — that pair was broken. It now throws `SecretValidationError` rather than a bare `Error`.
- **Decryption reports a missing salt** instead of ignoring the password and failing as "wrong password", which is what a proxy stripping `X-Salt` used to produce.
- **Chunked note headers are validated** rather than cast, matching the non-chunked path.
- **Package contents:** added the README and LICENSE (the npm page was blank), plus `sideEffects: false` and `engines`. Dropped the 1.2 MB sourcemap, taking the tarball from ~1.8 MB to 94 kB.
- **Every public method now carries TSDoc**, including which errors it throws and the fact that `readNote` consumes a read even when the password is wrong.
