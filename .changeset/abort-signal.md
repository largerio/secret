---
"@largerio/secret-sdk": minor
---

Calls can be cancelled.

- Every call takes an `AbortSignal`: `signal` in the options of `createNote` and `readNote`, and a new last argument `{ signal }` for `checkNote` and `deleteNote`. A cancelled call rejects with the signal's reason, whether the request is in flight, its body being read, or a retry being waited for, and is not retried.
- A client given its own `fetch` now sends multipart uploads through it too. They used to go through `XMLHttpRequest` whenever one existed, around the `fetch` the caller gave; such an upload reports no upload progress.
