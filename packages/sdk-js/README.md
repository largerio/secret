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
// → https://secret.example.com/note/aBcDeFgHiJkL#1.K7pQ...

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

## Formats

Notes are written in [format 1](https://github.com/largerio/secret/blob/main/PROTOCOL.md#format-1): the note is padded, so the instance learns its size class, not its length, and the server serves it only to a reader who proves they hold the link, and the password of a password note. Its links name the format: `#1.<key>`.

- An instance older than **1.6.0** refuses format 1 with a `400`. Pass `format: 0` to write to one.
- An SDK older than **1.3.0** cannot read a format 1 note: the instance refuses its read with a `400`, without spending one.

`readNote` takes either format, from the link: notes written in format 0, by older apps and SDKs, keep reading as before.

## Reading safely

`readNote` **consumes a read**, once the note is served.

A wrong password spends no read of a format 1 note: the server checks a proof of the password before it serves anything. It deletes the note at the fifth wrong password; `checkNote` reports the attempts left as `passwordAttemptsLeft`. A format 0 note cannot be checked that way: the server serves it before decryption is attempted, so a wrong password spends a read, and the only read of a burn-after-read note.

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

`maxReads` is the limit the note was created with (`0` means unlimited); `readCount` is how many of those reads are already spent, wrong passwords included on a format 0 note, since the server cannot tell them apart there:

```ts
if (info.maxReads > 0 && info.readCount !== undefined) {
  console.log(`${info.maxReads - info.readCount} read(s) left`);
}
```

`readCount` is always `0` on an unlimited note. It is optional because an instance running an older API does not send it: treat `undefined` as unknown, not as zero. The count can change between `checkNote` and `readNote` if someone else opens the note in the meantime.

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

`data` may also be a `Blob`: a browser's `File` as it was picked, or `fs.openAsBlob()` in Node 20 and later. The SDK reads it a slice at a time as it encrypts it, so a large file is never held in memory:

```ts
import { openAsBlob } from "node:fs";

const data = await openAsBlob("backup.tar");
await client.createNote({ files: [{ name: "backup.tar", type: "application/x-tar", data }] });

// In the browser, the picked File as it is:
await client.createNote({ files: [{ name: file.name, type: file.type, data: file }] });
```

Large payloads switch to a chunked upload automatically; `onProgress` reports `currentChunk` / `totalChunks` while it does. The upload session is opened first, then each chunk is encrypted as it goes up: only the chunk being sent is in memory. Chunks are 4 MiB by default. An instance that sets `CHUNK_SIZE` refuses larger chunks with a 413: pass the same value as `chunkSize`. A note's size counts its padding: up to 6.25% more than its content, and 4 KiB at least. A `format: 0` note is encrypted whole, its Blobs read into memory first.

### Reading into streams

`readNote` returns the files in memory. `readNoteInto` writes each one to a `WritableStream` you open for it, as the download reaches it, and returns the text and the list of files: a format 1 note is never held whole in memory, only the chunk being read.

```ts
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Writable } from "node:stream";

const note = await client.readNoteInto(id, keyFragment, {
  password,
  openFile: (file, index) => {
    const part = `./out/${index}.part`;
    const stream = Writable.toWeb(createWriteStream(part));
    const writer = stream.getWriter();
    return new WritableStream({
      write: (chunk) => writer.write(chunk),
      // Only now is the file whole: keep it.
      close: async () => {
        await writer.close();
        await rename(part, `./out/${index}-${file.name}`);
      },
      // The note was refused or the read failed: drop it.
      abort: async (reason) => {
        await writer.abort(reason);
        await rm(part, { force: true });
      },
    });
  },
});
console.log(note.text, note.files); // [{ name, type, size }]
```

A file's stream is closed only once the whole note is read and checked, and aborted if it is not: until then, what it holds may be a note cut short or tampered with, and must not be shown. A browser's `FileSystemWritableFileStream` works that way already: it writes to a copy, which `close()` keeps and `abort()` drops. A wrong password opens no stream. It consumes a read as `readNote` does, and takes the same options; a failure of one of your streams is thrown as it is. A format 0 note is read whole, then written out.

## Errors

Every failure path is typed, so you can branch on the cause:

| Class | When | Notable |
|---|---|---|
| `SecretValidationError` | The request is malformed or exceeds a protocol limit | Thrown before any encryption or network work |
| `SecretApiError` | The server responded with an error | `.status` carries the HTTP code (`0` for a timeout), `.code` the instance's name for the error (`note_not_found`, `rate_limited`…, see [Errors](https://github.com/largerio/secret/blob/main/PROTOCOL.md#errors)), and `.retryAfter` a `429`'s wait in seconds. A missing or wrong `apiKey` on a write surfaces here as `401`. An error without a `.code` came from something in front of the instance (a proxy, a firewall), or from an instance older than 1.7.0 |
| `SecretNetworkError` | The request failed in transit | DNS, offline, connection reset, CORS, or a connection lost mid-download. `.cause` holds the original error |
| `SecretDecryptionError` | The note could not be decrypted | Wrong password, wrong key and tampered ciphertext are **intentionally indistinguishable** — telling them apart would make this a password oracle. On a format 1 note, the server refuses a wrong link or password before serving anything; that refusal surfaces here too |

```ts
import { SecretApiError, SecretDecryptionError, SecretNetworkError } from "@largerio/secret-sdk";

try {
  await client.readNote(id, keyFragment, { password });
} catch (err) {
  if (err instanceof SecretDecryptionError) return showWrongPassword();
  if (err instanceof SecretNetworkError) return showOffline();   // checkNote before retrying: a dropped download may have spent the read
  if (err instanceof SecretApiError && err.code === "note_not_found") return showGone();
  if (err instanceof SecretApiError && err.code === "rate_limited") return retryIn(err.retryAfter);
  throw err;
}
```

Note that a missing note is a `404` from `readNote`, but `{ exists: false }` from `checkNote` — the latter never throws for that case.

## Cancelling

Every call takes an `AbortSignal`: `createNote`, `readNote` and `readNoteInto` in their options, `checkNote` and `deleteNote` in a last argument. A cancelled call rejects with the signal's reason, an `AbortError` unless you gave another:

```ts
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();

await client.createNote({ files, signal: controller.signal });
await client.checkNote(id, { signal: AbortSignal.timeout(5_000) });
```

What was done stays done. A read the server has started to serve is spent, and an upload session cut short is left to expire on the instance.

## Configuration

```ts
await SecretClient.create({
  baseUrl: "https://secret.example.com",  // default: "" (relative — browser, same origin)
  apiKey: "…",                            // sent as `Authorization: Bearer …`
  timeoutMs: 30_000,                      // default: none
  maxRetries: 2,                          // default: 0 — checkNote and chunk PUTs only
  retryBackoffMs: (attempt) => attempt * 500, // ms before retry N (1-based). Default: 2 ** N * 250
  fetch: customFetch,                     // defaults to globalThis.fetch; uploads go through it too, without upload progress
});
```

Note creation, deletion and `readNote` are deliberately never retried: a retried `createNote` could store the note twice, and a retried read could spend a second read — or destroy a burn-after-read note before you see it.

## Reference

| Method | |
|---|---|
| `SecretClient.create(config?)` | Build a client with libsodium initialised |
| `createNote(options)` | Encrypt and upload; returns `{ id, keyFragment, deleteToken, expiresAt }` |
| `readNote(id, keyFragment, options?)` | Download and decrypt — **consumes a read** |
| `readNoteInto(id, keyFragment, options)` | Download and decrypt into your streams — **consumes a read** |
| `checkNote(id)` | Metadata only; consumes nothing |
| `deleteNote(id, deleteToken, capToken?)` | Revoke before expiry |
| `buildShareUrl(id, keyFragment)` | Assemble the share URL |
| `SecretClient.parseShareUrl(url)` | Split one back into `{ id, keyFragment }` |

## Requirements

Node.js ≥ 18, or any browser with WebAssembly and `crypto.getRandomValues`.

`libsodium-wrappers-sumo` and `@msgpack/msgpack` are runtime dependencies, installed with the package.

## Security model

The threat model, guarantees and known limitations are documented in [SECURITY.md](https://github.com/largerio/secret/blob/main/SECURITY.md). In short: the server stores ciphertext it cannot read, but it does see timing and expiry metadata, and a note's size: its size class for a format 1 note, its exact size for a format 0 one.

## License

MIT — see [LICENSE](./LICENSE).
