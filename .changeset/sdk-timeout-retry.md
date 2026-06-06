---
"@secret/sdk-js": minor
---

Add per-request timeout and automatic retries to `SecretClient`. New
`SecretClientConfig` options: `timeoutMs` (aborts any request that runs too
long), `maxRetries`, and `retryBackoffMs`. Retries apply only to idempotent
requests — reads and chunk uploads — so note creation and deletion are never
duplicated. Standard file uploads now report smooth byte-level progress on the
overall progress bar instead of jumping at phase boundaries.
