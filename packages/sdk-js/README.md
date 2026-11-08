# @largerio/secret-sdk

The JavaScript/TypeScript SDK for [Secret](https://github.com/largerio/secret). It creates, reads and deletes end-to-end encrypted notes and files on any Secret instance.

Notes are encrypted **in your process**, with XChaCha20-Poly1305, before anything is sent. The decryption key never leaves your process: you get it back as a key fragment, and the server never sees it.

```bash
npm install @largerio/secret-sdk
```

It works in Node.js and in the browser, and ships as ESM with TypeScript types. To use Secret from a terminal or a shell script, there's a command line built on it, [`@largerio/secret-cli`](https://www.npmjs.com/package/@largerio/secret-cli), with `secret send` and `secret read`.

> **Reading is open on every instance. Writing isn't.** `createNote` and `deleteNote` need either an API key, which the instance's operator sets in its environment, or a [proof of work](#proof-of-work-instead-of-a-key). There's no sign-up: point the SDK at an instance you run, or at one that gave you a key. See [Instances and access](#instances-and-access).

## Quick start

```ts
import { SecretClient } from "@largerio/secret-sdk";

// `create`, not `new`: it waits for the libsodium WASM module to load.
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
| One that gave you a key | ✅ | ✅ with that key |
| Any other public instance | ✅ | With a [proof-of-work token](#proof-of-work-instead-of-a-key), otherwise `401 Unauthorized` |

You don't sign up for an API key: it's a value the operator puts in the instance's environment (`API_KEY=…`, 32 characters minimum). The public demo at `secret.larger.io` is no exception: a `createNote` with neither a key nor a proof-of-work token gets a `401`.

Running your own instance takes three lines:

```bash
curl -O https://raw.githubusercontent.com/largerio/secret/main/docker-compose.yml
echo "API_KEY=$(openssl rand -base64 32)" > .env
docker compose up -d      # → http://localhost:3000
```

That key is the one you pass as `apiKey`. The [self-hosting guide](https://github.com/largerio/secret/blob/main/docs/self-hosting.md) covers a real deployment, and `API_KEY_1`, `API_KEY_2`… for one key per client.

### Calling from a browser

An instance only answers cross-origin requests from one origin: the `APP_URL` it was configured with. A page served from any other domain is blocked by CORS, **reads included**. So either call the SDK from your server, or serve your front end from the instance's own origin.

### Proof of work instead of a key

Without a key, each write can carry a proof-of-work token instead. That's how the web app writes without shipping a key to the browser, and how the command line writes on any instance:

```ts
await client.createNote({ text: "hi", capToken });
```

You get the token by solving the instance's [Cap](https://capjs.js.org) challenge, under `/api/cap/`. The web app uses Cap's widget, and the command line its own solver; [PROTOCOL.md](https://github.com/largerio/secret/blob/main/PROTOCOL.md#proof-of-work) specifies the challenge for any other client. The SDK doesn't solve it for you.

## Formats

Notes are written in [format 1](https://github.com/largerio/secret/blob/main/PROTOCOL.md#format-1). The note is padded, so the instance learns its size class but not its length, and the server only serves it to a reader who proves they hold the link, plus the password if there is one. Format 1 links name their format: `#1.<key>`.

Instances older than 1.6.0 refuse format 1 with a `400`. To write to one, pass `format: 0`, the [legacy format](https://github.com/largerio/secret/blob/main/PROTOCOL.md#format-0-legacy). `readNote` reads either format, based on the link.

## Reading safely

`readNote` **spends a read** as soon as the note is served.

On a format 1 note, a wrong password spends no read: the server checks a proof of the password before serving anything. The fifth wrong password deletes the note, and `checkNote` reports the attempts left as `passwordAttemptsLeft`. A format 0 note can't be protected that way: the server serves it before decryption is attempted, so a wrong password spends a read, which may be the only read of a burn-after-read note.

So check first, then ask for the password, then read once:

```ts
const info = await client.checkNote(id);

if (!info.exists) {
  // Expired, already read, or never existed: deliberately indistinguishable.
  return;
}

const password = info.hasPassword ? await promptUser() : undefined;
const { payload } = await client.readNote(id, keyFragment, { password });
```

`NoteInfo` is a discriminated union: narrow on `exists` before touching any other field.

`maxReads` is the limit the note was created with (`0` means unlimited), and `readCount` is how many of those reads are already spent. On a format 0 note, that includes wrong passwords, since the server can't tell them apart:

```ts
if (info.maxReads > 0 && info.readCount !== undefined) {
  console.log(`${info.maxReads - info.readCount} read(s) left`);
}
```

`readCount` is always `0` on an unlimited note. It's optional because instances running an older API don't send it, so treat `undefined` as unknown, not as zero. The count can change between `checkNote` and `readNote` if someone else opens the note in the meantime.

## Files

A file is a name, a MIME type and its bytes. The SDK never touches the filesystem itself:

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

`data` can also be a `Blob`: a `File` picked in a browser, or `fs.openAsBlob()` in Node 20 and later. The SDK then reads it a slice at a time as it encrypts it, so a large file is never held in memory:

```ts
import { openAsBlob } from "node:fs";

const data = await openAsBlob("backup.tar");
await client.createNote({ files: [{ name: "backup.tar", type: "application/x-tar", data }] });

// In the browser, the picked File as it is:
await client.createNote({ files: [{ name: file.name, type: file.type, data: file }] });
```

Large payloads switch to a chunked upload automatically, and `onProgress` then reports `currentChunk` / `totalChunks`. The SDK opens the upload session first, then encrypts each chunk as it uploads it, so only the chunk being sent is in memory.

Chunks are 4 MiB by default. An instance that sets its own `CHUNK_SIZE` refuses larger chunks with a `413`, so pass the same value as `chunkSize`. A note's size includes its padding: up to 6.25% more than its content, and at least 4 KiB. A `format: 0` note is encrypted in one piece, with its Blobs read into memory first.

### Reading into streams

`readNote` returns the files in memory. `readNoteInto` writes each one to a `WritableStream` you open for it, as the download arrives, and returns the text and the list of files. A format 1 note is then never held whole in memory, only the chunk being read.

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

A file's stream is only closed once the whole note has been read and checked, and it's aborted otherwise. Until then, what it holds may come from a truncated or tampered note, and must not be shown. A browser's `FileSystemWritableFileStream` already works that way: it writes to a copy, which `close()` keeps and `abort()` drops.

A wrong password opens no stream. `readNoteInto` spends a read like `readNote`, and takes the same options. If one of your streams fails, its error is thrown as is. A format 0 note is read in one piece, then written out.

## Errors

Every failure is typed, so you can branch on the cause:

| Class | When | Notable |
|---|---|---|
| `SecretValidationError` | The request is malformed or exceeds a protocol limit | Thrown before any encryption or network work. Every method refuses a malformed note id (anything but 12 characters from `A-Z a-z 0-9 _ -`) and a key that isn't 32 bytes in base64url, so a mistyped or truncated link spends no read |
| `SecretApiError` | The server answered with an error | `.status` holds the HTTP status (`0` for a timeout), `.code` the instance's name for the error (`note_not_found`, `rate_limited`…, see [Errors](https://github.com/largerio/secret/blob/main/PROTOCOL.md#errors)), and `.retryAfter` how long a `429` asks you to wait, in seconds. A missing or wrong `apiKey` on a write shows up here as a `401`. An error without a `.code` came from something in front of the instance, such as a proxy or a firewall |
| `SecretNetworkError` | The request failed in transit | DNS, offline, connection reset, CORS, or a connection lost mid-download. `.cause` holds the original error |
| `SecretDecryptionError` | The note couldn't be decrypted | A wrong password, a wrong key and a tampered ciphertext are **deliberately indistinguishable**: telling them apart would turn this into a password oracle. On a format 1 note, the server refuses a wrong link or password before serving anything, and that refusal surfaces here too |

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

Note that a missing note is a `404` from `readNote`, but `{ exists: false }` from `checkNote`, which never throws in that case.

## Cancelling

Every call takes an `AbortSignal`: in the options of `createNote`, `readNote` and `readNoteInto`, and as the last argument of `checkNote` and `deleteNote`. A cancelled call rejects with the signal's reason, which is an `AbortError` unless you gave another one:

```ts
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();

await client.createNote({ files, signal: controller.signal });
await client.checkNote(id, { signal: AbortSignal.timeout(5_000) });
```

Cancelling doesn't undo anything. A read the server has started to serve is spent, and an upload session cut short is left to expire on the instance.

## Configuration

```ts
await SecretClient.create({
  baseUrl: "https://secret.example.com",  // default: "" (relative: a browser, same origin)
  apiKey: "…",                            // sent as `Authorization: Bearer …`
  timeoutMs: 30_000,                      // default: none
  maxRetries: 2,                          // default: 0; checkNote and chunk PUTs only
  retryBackoffMs: (attempt) => attempt * 500, // ms before retry N (1-based). Default: 2 ** N * 250
  fetch: customFetch,                     // defaults to globalThis.fetch; uploads go through it too, without upload progress
});
```

Creating, deleting and `readNote` are deliberately never retried. A retried `createNote` could store the note twice, and a retried read could spend a second read, or destroy a burn-after-read note before you see it.

## Reference

| Method | |
|---|---|
| `SecretClient.create(config?)` | Builds a client, with libsodium initialized |
| `createNote(options)` | Encrypts and uploads; returns `{ id, keyFragment, deleteToken, expiresAt }` |
| `readNote(id, keyFragment, options?)` | Downloads and decrypts. **Spends a read** |
| `readNoteInto(id, keyFragment, options)` | Downloads and decrypts into your streams. **Spends a read** |
| `checkNote(id)` | Metadata only; spends nothing |
| `deleteNote(id, deleteToken, capToken?)` | Deletes the note before it expires |
| `buildShareUrl(id, keyFragment)` | Builds the share URL |
| `SecretClient.parseShareUrl(url)` | Splits one back into `{ id, keyFragment }` |

The protocol's limits are exported too, so you can check a note before sending it:

- `MAX_TEXT_SIZE`: 102,400 characters of text
- `MAX_FILES_PER_NOTE`: 10
- `MAX_READS`: 1000
- `MIN_EXPIRY_SECONDS`: 300, and `MAX_EXPIRY_SECONDS`: 2,592,000 (30 days)
- `DEFAULT_EXPIRY_SECONDS`: 86,400, what `createNote` uses when `expiresIn` isn't given
- `DEFAULT_CHUNK_SIZE`: 4 MiB, the default `chunkSize`
- `NOTE_ID_LENGTH`: 12
- `MAX_PASSWORD_ATTEMPTS`: 5, the wrong passwords that delete a format 1 note

An instance may set lower limits of its own, which `GET /api/v1/config` returns ([Instance limits](https://github.com/largerio/secret/blob/main/PROTOCOL.md#instance-limits)).

## Requirements

Node.js 18 or later, or any browser with WebAssembly and `crypto.getRandomValues`.

`libsodium-wrappers-sumo` and `@msgpack/msgpack` are runtime dependencies, installed with the package.

## Security model

[SECURITY.md](https://github.com/largerio/secret/blob/main/SECURITY.md) documents the threat model, the guarantees and the known limitations. In short, the server stores ciphertext it can't read, but it does see timing and expiry metadata, and a note's size: its size class for a format 1 note, and its exact size for a format 0 one.

## License

[MIT](./LICENSE)
