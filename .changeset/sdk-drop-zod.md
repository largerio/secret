---
"@largerio/secret-sdk": patch
---

The published bundle no longer ships zod: `dist/index.js` drops from 803 KB to 41 KB (127 KB to 10 KB gzipped). A single schema import, used to check the response of a multipart upload, pulled the whole library in. That check is now a plain type guard and rejects the same malformed responses with the same `SecretApiError("Invalid response")`. Nothing changes in the API.
