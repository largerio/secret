# @largerio/secret-sdk

## 1.2.0

### Minor Changes

- e49d9d1: `checkNote` reports `readCount`: the reads a note has already spent, wrong passwords included, so `maxReads - readCount` is what is left before opening it. It is always `0` on a note without a read limit. The field is optional on `ExistingNoteInfo`, since an instance running an older API does not send it, and `checkNote` still accepts that response. A `readCount` that is present but not a non-negative integer is rejected as a malformed response, like any other field.

## 1.1.3

### Patch Changes

- a2ce1d1: The published bundle no longer ships zod: `dist/index.js` drops from 803 KB to 41 KB (127 KB to 10 KB gzipped). A single schema import, used to check the response of a multipart upload, pulled the whole library in. That check is now a plain type guard and rejects the same malformed responses with the same `SecretApiError("Invalid response")`. Nothing changes in the API.

## 1.1.2

### Patch Changes

- 3b7692f: Chunked uploads no longer depend on `crypto.subtle`. Browsers only expose it in a secure context, so on a page served over plain HTTP from a non-localhost address (an instance on a LAN, `http://<ip>:3000`) every upload above the chunk size failed with a `TypeError`. Chunk hashes now come from libsodium, which the SDK already loads.
- 0af8eb2: Safer reads and a stricter stream check.
  
  - `readNote` is never retried, whatever `maxRetries` says: a read spends one of the note's reads as soon as the server answers, so a retry after a timeout or a 5xx could spend a second one, or destroy a burn-after-read note and report a 404 instead of the real error. `checkNote` and chunk uploads are still retried.
  - A chunked note must end on its FINAL chunk, with nothing after it. A stream cut down to its header chunk used to decrypt to files with their declared size and no data; it now fails with `SecretDecryptionError`.
  - A missing salt on a password note surfaces as `SecretValidationError`, as documented, instead of being reported as a wrong password.
  - A network error during a multipart upload (XHR) and a connection lost mid-download are `SecretNetworkError`, like every other transport failure.
  - `parseShareUrl` reports a malformed escape as `SecretValidationError`, and a `baseUrl` with a trailing slash no longer produces `//api/v1` URLs.

## 1.1.1

### Patch Changes

- 03460f0: Fix a README that sent new users straight into a 401.

  The quick start pointed at the public demo instance with no credentials and then called `createNote` — a write, which every instance rejects without an API key or a PoW token. The constraint was only stated 60 lines further down. It is now the first thing the README says, with a table of what each kind of instance allows and the two commands that stand up an instance you hold the key to.

  Two examples were also wrong: `files` was shown taking a browser `File` (the option takes `{ name, type, data: Uint8Array }`, so the example did not typecheck and would have thrown on `data.length`), and `retryBackoffMs` was shown as a number (it is `(attempt: number) => number`). Documents the CORS constraint on browser callers, corrects the defaults for `timeoutMs` and `maxRetries`, and stops calling the two runtime dependencies "peer".

## 1.1.0

### Minor Changes

- 1663ab4: Fix the published package: the generated `.d.ts` imported `@largerio/secret-shared`, a private workspace package that is never published, so every TypeScript consumer got `TS2307` — including on the README example. The payload types are now declared in the SDK itself, with a compile-time contract test keeping them identical to the shared definitions.

  Also in this release:

  - **Added `SecretNetworkError`.** A failed fetch (DNS, offline, connection reset, CORS) escaped as a raw `TypeError`, so `instanceof SecretApiError` missed it and callers had no typed way to tell a transport failure from a rejection. The original error is available as `.cause`.
  - **`NoteInfo` is now a discriminated union.** The API returns only `{exists: false}` for a missing note, so declaring the other fields as always-present made the type lie: reading `info.maxReads` on a missing note silently gave `undefined`. Narrow on `exists` first. `checkNote` also validates the response shape instead of casting it, and no longer has a dead 404 branch the API never takes.
  - **`parseShareUrl` accepts relative URLs**, so it round-trips `buildShareUrl` under the default configuration — that pair was broken. It now throws `SecretValidationError` rather than a bare `Error`.
  - **Decryption reports a missing salt** instead of ignoring the password and failing as "wrong password", which is what a proxy stripping `X-Salt` used to produce.
  - **Chunked note headers are validated** rather than cast, matching the non-chunked path.
  - **Package contents:** added the README and LICENSE (the npm page was blank), plus `sideEffects: false` and `engines`. Dropped the 1.2 MB sourcemap, taking the tarball from ~1.8 MB to 94 kB.
  - **Every public method now carries TSDoc**, including which errors it throws and the fact that `readNote` consumes a read even when the password is wrong.
