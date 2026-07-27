# @largerio/secret-sdk

JavaScript/TypeScript SDK for [Secret](https://github.com/largerio/secret) — create, read and delete zero-knowledge, end-to-end encrypted notes and files on any Secret instance.

The payload is encrypted **in your process** with XChaCha20-Poly1305 before anything is sent. The decryption key never leaves it: it is returned to you as a key fragment, and the server never sees it.

```bash
npm install @largerio/secret-sdk
```

Works in Node.js and in the browser. Ships as ESM with TypeScript types.

> **Reads are open on every instance. Writes are not.** `createNote` and `deleteNote` need an API key — a string the instance operator sets in their own environment. There is no sign-up: point the SDK at an instance you run, or at one that issued you a key. See [Instances and access](#instances-and-access).

## Quick start

```ts
import { SecretClient } from "@largerio/secret-sdk";

// `create` (not `new`) — it waits for the libsodium WASM module to load.
const client = await SecretClient.create({
  baseUrl: "https://secret.example.com", // the instance you talk to
  apiKey: process.env.SECRET_API_KEY,    // required to write
});

const { id, keyFragment, deleteToken } = await client.createNote({
  text: "the launch code is 0000",
  maxReads: 1,        // burn after the first read
  expiresIn: 3600,    // …or after an hour, whichever comes first
});

// The fragment is the key. It is not stored server-side and cannot be recovered.
console.log(client.buildShareUrl(id, keyFragment));
// → https://secret.example.com/note/aBcDeFgHiJkL#K7pQ...

const { payload } = await client.readNote(id, keyFragment);
console.log(payload.text); // "the launch code is 0000"
```

## Instances and access

| Instance | `checkNote` / `readNote` | `createNote` / `deleteNote` |
|---|---|---|
| One you run | ✅ | ✅ with the `API_KEY` you set |
| One that issued you a key | ✅ | ✅ with that key |
| Any other public instance | ✅ | ❌ `401 Unauthorized` |

An API key is not something you sign up for — it is a value the operator puts in the instance's environment (`API_KEY=…`, 32 characters minimum). The public demo at `secret.larger.io` is no exception: a `createNote` without credentials gets a flat `401`. Against an instance where you hold no key, the SDK is read-only.

Running your own takes three lines:

```bash
curl -O https://raw.githubusercontent.com/largerio/secret/main/docker-compose.yml
echo "API_KEY=$(openssl rand -base64 32)" > .env
docker compose up -d      # → http://localhost:3000
```

That key is now the one you pass as `apiKey`. See the [self-hosting guide](https://github.com/largerio/secret/blob/main/docs/self-hosting.md) for a real deployment, and `API_KEY_1`, `API_KEY_2`… when you want one key per client.

### Calling from a browser

An instance answers cross-origin requests from exactly one origin: the `APP_URL` it was configured with. A page served from any other domain is blocked by CORS — **reads included**. So either call the SDK from your server, or serve your front-end from the instance's own origin.

### Proof-of-Work instead of a key

Instances also accept a Cap Proof-of-Work token per write, which is how the bundled web UI writes without shipping a key to the browser:

```ts
await client.createNote({ text: "hi", capToken });
```

The token comes from the [Cap](https://capjs.js.org) widget solving a challenge against the instance's own `/api/cap/` endpoints — a browser path, same-origin by construction. Anything server-side: use an API key.

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

A file is a name, a MIME type and the bytes — the SDK never touches the filesystem itself:

```ts
import { readFile } from "node:fs/promises";

const { id, keyFragment } = await client.createNote({
  text: "see attached",
  files: [
    {
      name: "report.pdf",
      type: "application/pdf",
      data: new Uint8Array(await readFile("report.pdf")),
    },
  ],
  onProgress: ({ phase, overallProgress }) => {
    console.log(phase, Math.round(overallProgress * 100) + "%");
  },
});
```

In the browser, turn a picked `File` into that shape with
`{ name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) }`.

Large payloads switch to a chunked upload automatically; `onProgress` reports `currentChunk` / `totalChunks` while it does.

## Errors

Every failure path is typed, so you can branch on the cause:

| Class | When | Notable |
|---|---|---|
| `SecretValidationError` | The request is malformed or exceeds a protocol limit | Thrown before any encryption or network work |
| `SecretApiError` | The server responded with an error | `.status` carries the HTTP code (`0` for a timeout). A missing or wrong `apiKey` on a write surfaces here as `401` |
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
  baseUrl: "https://secret.example.com",  // default: "" (relative — browser, same origin)
  apiKey: "…",                            // sent as `Authorization: Bearer …`
  timeoutMs: 30_000,                      // default: none
  maxRetries: 2,                          // default: 0 — reads and chunk PUTs only
  retryBackoffMs: (attempt) => attempt * 500, // ms before retry N (1-based). Default: 2 ** N * 250
  fetch: customFetch,                     // defaults to globalThis.fetch
});
```

Note creation and deletion are deliberately never retried: a retried `createNote` could store the note twice.

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

`libsodium-wrappers-sumo` and `@msgpack/msgpack` are runtime dependencies, installed with the package.

## Security model

The threat model, guarantees and known limitations are documented in [SECURITY.md](https://github.com/largerio/secret/blob/main/SECURITY.md). In short: the server stores ciphertext it cannot read, but it does see note size, timing and expiry metadata.

## License

MIT — see [LICENSE](./LICENSE).
