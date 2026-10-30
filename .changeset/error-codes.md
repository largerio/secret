---
"@largerio/secret-sdk": minor
---

Errors name their cause.

- `SecretApiError` carries the instance's `code` for the error (`note_not_found`, `wrong_delete_token`, `rate_limited`…, listed in [PROTOCOL.md](https://github.com/largerio/secret/blob/main/PROTOCOL.md#errors)), and `retryAfter`, the seconds a `429` asks to wait. Instances from 1.7.0 answer every error with problem details; the SDK still reads the `{"error"}` answers of older ones, without a code.
- A `403` that the instance did not answer, from a firewall or a proxy in front of it, is no longer read as a wrong password or link: `readNote` throws it as a `SecretApiError`, without a code, instead of a `SecretDecryptionError`. A reader would otherwise spend password attempts on a password that was right.
