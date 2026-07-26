# @largerio/secret-sdk

JavaScript/TypeScript SDK for [Secret](https://github.com/largerio/secret) — create, read and delete zero-knowledge, end-to-end encrypted notes and files on any Secret instance.

The payload is encrypted **in your process** with XChaCha20-Poly1305 before anything is sent. The decryption key never leaves it: it is returned to you as a key fragment, and the server never sees it.

```bash
npm install @largerio/secret-sdk
```

Works in Node.js and in the browser. Ships as ESM with TypeScript types.

## Quick start

```ts
import { SecretClient } from "@largerio/secret-sdk";

// `create` (not `new`) — it waits for the libsodium WASM module to load.
const client = await SecretClient.create({ baseUrl: "https://secret.larger.io" });

const { id, keyFragment, deleteToken } = await client.createNote({
  text: "the launch code is 0000",
  maxReads: 1,        // burn after the first read
  expiresIn: 3600,    // …or after an hour, whichever comes first
});

// The fragment is the key. It is not stored server-side and cannot be recovered.
console.log(client.buildShareUrl(id, keyFragment));
// → https://secret.larger.io/note/aBcDeFgHiJkL#K7pQ...

const { payload } = await client.readNote(id, keyFragment);
console.log(payload.text); // "the launch code is 0000"
```

## Reading safely

`readNote` **consumes a read**. On a burn-after-read note the server destroys it the moment the ciphertext is served — before decryption is attempted — so a wrong password still spends the only read.

Check first, then collect the password, then read once:

```ts
const info = await client.checkNote(id);

if (!info.exists) {
  // Expired, already read, or never existed — deliberately indistinguishable.
  return;
}

const password = info.hasPassword ? await promptUser() : undefined;
const { payload } = await client.readNote(id, keyFragment, { password });
```

`NoteInfo` is a discriminated union: narrow on `exists` before touching any other field.

## Files

```ts
const file = new File([bytes], "report.pdf", { type: "application/pdf" });

const { id, keyFragment } = await client.createNote({
  text: "see attached",
  files: [file],
  onProgress: ({ phase, overallProgress }) => {
    console.log(phase, Math.round(overallProgress * 100) + "%");
  },
});
```

Large payloads switch to a chunked upload automatically; `onProgress` reports `currentChunk` / `totalChunks` while it does.

## Authentication

Reads are open on every instance. **Writes are not**: `createNote` and `deleteNote` need either an API key or a Proof-of-Work token.

```ts
// Instances that issued you an API key:
const client = await SecretClient.create({ baseUrl, apiKey: process.env.SECRET_API_KEY });

// Public instances: solve a Proof-of-Work challenge and pass the token.
await client.createNote({ text: "hi", capToken });
```

Against a public instance where you hold no key, the SDK is effectively read-only.

## Errors

Every failure path is typed, so you can branch on the cause:

| Class | When | Notable |
|---|---|---|
| `SecretValidationError` | The request is malformed or exceeds a protocol limit | Thrown before any encryption or network work |
| `SecretApiError` | The server responded with an error | `.status` carries the HTTP code (`0` for a timeout) |
| `SecretNetworkError` | The request never reached the server | DNS, offline, connection reset, CORS. `.cause` holds the original error |
| `SecretDecryptionError` | The note could not be decrypted | Wrong password, wrong key and tampered ciphertext are **intentionally indistinguishable** — telling them apart would make this a password oracle |

```ts
import { SecretApiError, SecretDecryptionError, SecretNetworkError } from "@largerio/secret-sdk";

try {
  await client.readNote(id, keyFragment, { password });
} catch (err) {
  if (err instanceof SecretDecryptionError) return showWrongPassword();
  if (err instanceof SecretNetworkError) return showOffline();   // safe to retry
  if (err instanceof SecretApiError && err.status === 404) return showGone();
  throw err;
}
```

Note that a missing note is a `404` from `readNote`, but `{ exists: false }` from `checkNote` — the latter never throws for that case.

## Configuration

```ts
await SecretClient.create({
  baseUrl: "https://secret.example.com", // default: "" (relative — browser, same origin)
  apiKey: "…",                           // sent as `Authorization: Bearer …`
  timeoutMs: 30_000,
  maxRetries: 2,                         // GETs only; writes are never retried
  retryBackoffMs: 300,
  fetch: customFetch,                    // defaults to globalThis.fetch
});
```

Writes are deliberately never retried: a retried `createNote` could store the note twice.

## Reference

| Method | |
|---|---|
| `SecretClient.create(config?)` | Build a client with libsodium initialised |
| `createNote(options)` | Encrypt and upload; returns `{ id, keyFragment, deleteToken, expiresAt }` |
| `readNote(id, keyFragment, options?)` | Download and decrypt — **consumes a read** |
| `checkNote(id)` | Metadata only; consumes nothing |
| `deleteNote(id, deleteToken, capToken?)` | Revoke before expiry |
| `buildShareUrl(id, keyFragment)` | Assemble the share URL |
| `SecretClient.parseShareUrl(url)` | Split one back into `{ id, keyFragment }` |

## Requirements

Node.js ≥ 18, or any browser with WebAssembly and `crypto.getRandomValues`.

`libsodium-wrappers-sumo` and `@msgpack/msgpack` are peer runtime dependencies, installed automatically.

## Security model

The threat model, guarantees and known limitations are documented in [SECURITY.md](https://github.com/largerio/secret/blob/main/SECURITY.md). In short: the server stores ciphertext it cannot read, but it does see note size, timing and expiry metadata.

## License

MIT — see [LICENSE](./LICENSE).
