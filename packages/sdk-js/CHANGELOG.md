# @largerio/secret-sdk

## 1.4.0

### Minor Changes

- 828a605: Calls can be cancelled.
  
  - Every call takes an `AbortSignal`: `signal` in the options of `createNote` and `readNote`, and a new last argument `{ signal }` for `checkNote` and `deleteNote`. A cancelled call rejects with the signal's reason, whether the request is in flight, its body being read, or a retry being waited for, and is not retried.
  - A client given its own `fetch` now sends multipart uploads through it too. They used to go through `XMLHttpRequest` whenever one existed, around the `fetch` the caller gave; such an upload reports no upload progress.
- e8492d2: Errors name their cause.
  
  - `SecretApiError` carries the instance's `code` for the error (`note_not_found`, `wrong_delete_token`, `rate_limited`…, listed in [PROTOCOL.md](https://github.com/largerio/secret/blob/main/PROTOCOL.md#errors)), and `retryAfter`, the seconds a `429` asks to wait. Instances from 1.7.0 answer every error with problem details; the SDK still reads the `{"error"}` answers of older ones, without a code.
  - A `403` that the instance did not answer, from a firewall or a proxy in front of it, is no longer read as a wrong password or link: `readNote` throws it as a `SecretApiError`, without a code, instead of a `SecretDecryptionError`. A reader would otherwise spend password attempts on a password that was right.
- 9feb10e: Large notes no longer need to fit in memory.
  
  - A file's `data` may be a `Blob`: a browser's `File` as it was picked, or `fs.openAsBlob()` in Node. The SDK reads it a slice at a time as it encrypts it.
  - A note sent in an upload session has its session opened first, then each chunk encrypted as it goes up: only the chunk being sent is held, and a refused session (too large, a full instance) costs no encryption. Format 0 notes are still encrypted whole.
  - `readNoteInto(id, keyFragment, { openFile })` writes each file to a `WritableStream` you open for it, as the download reaches it, and returns the text and the list of files. Each stream is closed once the whole note is read and checked, and aborted otherwise, so nothing of a note cut short or tampered with is kept. Format 0 notes are read whole, then written out.
  - Reads take the note's chunks off the response as they arrive, rather than once the whole response is in.

## 1.3.0

### Minor Changes

- 6843f1c: Format 1, written by default.
  
  - `createNote` writes [format 1](https://github.com/largerio/secret/blob/main/PROTOCOL.md#format-1) unless `format: 0` is passed. Its links name the format (`#1.<key>`). The note is padded to a size class (Padmé, 4 KiB at least), so the instance learns its size class instead of its length. Its settings travel in an envelope the ciphertext authenticates, with the Argon2id parameters of a password note, and the password is normalized to NFC.
  - `readNote` takes either format, from the link. A format 1 note is served only once the reader proves it holds the link, and the password of a password note: a wrong password spends no read, and the fifth deletes the note. `checkNote` reports the note's `envelope` and its `passwordAttemptsLeft`. A wrong link or password refused by the instance is a `SecretDecryptionError`, like a key that fails to decrypt.
  - An instance older than 1.6.0 refuses format 1 with a `400`: pass `format: 0` to write to one. An SDK older than 1.3.0 cannot read a format 1 note (the instance refuses its read with a `400`, without spending one): update the readers before the writers.
  
  Format 0 notes read and write as before.

## 1.2.1

### Patch Changes

- 70434fd: Two fixes to chunked uploads.
  
  - A chunked note whose last file was empty, after a file with data, could not be read: no chunk carried the FINAL tag the reader requires since 1.1.2, so `readNote` failed with `SecretDecryptionError` after spending the read. The stream now ends on the last chunk of the last file with data.
  - A note without files no longer switches to a chunked upload when its text exceeds `chunkSize`. All its text went in the first chunk, which an instance refuses beyond its chunk size (413); it is now sent single-shot, which takes any text `MAX_TEXT_SIZE` allows. `chunked: true` still forces a chunked upload.

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
