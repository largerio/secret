---
"@largerio/secret-sdk": patch
---

Safer reads and a stricter stream check.

- `readNote` is never retried, whatever `maxRetries` says: a read spends one of the note's reads as soon as the server answers, so a retry after a timeout or a 5xx could spend a second one, or destroy a burn-after-read note and report a 404 instead of the real error. `checkNote` and chunk uploads are still retried.
- A chunked note must end on its FINAL chunk, with nothing after it. A stream cut down to its header chunk used to decrypt to files with their declared size and no data; it now fails with `SecretDecryptionError`.
- A missing salt on a password note surfaces as `SecretValidationError`, as documented, instead of being reported as a wrong password.
- A network error during a multipart upload (XHR) and a connection lost mid-download are `SecretNetworkError`, like every other transport failure.
- `parseShareUrl` reports a malformed escape as `SecretValidationError`, and a `baseUrl` with a trailing slash no longer produces `//api/v1` URLs.
