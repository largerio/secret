---
"@largerio/secret-sdk": patch
---

Fix a README that sent new users straight into a 401.

The quick start pointed at the public demo instance with no credentials and then called `createNote` — a write, which every instance rejects without an API key or a PoW token. The constraint was only stated 60 lines further down. It is now the first thing the README says, with a table of what each kind of instance allows and the two commands that stand up an instance you hold the key to.

Two examples were also wrong: `files` was shown taking a browser `File` (the option takes `{ name, type, data: Uint8Array }`, so the example did not typecheck and would have thrown on `data.length`), and `retryBackoffMs` was shown as a number (it is `(attempt: number) => number`). Documents the CORS constraint on browser callers, corrects the defaults for `timeoutMs` and `maxRetries`, and stops calling the two runtime dependencies "peer".
