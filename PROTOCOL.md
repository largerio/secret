# Secret protocol

This document specifies how a Secret client encrypts a note, what it sends to
an instance, and how it reads one back: enough to write a compatible client,
in any language, without reading the SDK. It describes **format 0**, the
format every release so far writes and reads, then [format 1](#format-1),
its successor, still a draft.

The reference implementation is [`packages/crypto`](packages/crypto/src) and
[`packages/sdk-js`](packages/sdk-js/src). The [test vectors](#test-vectors)
pin every step down to the byte. The HTTP API is also described by the
instance itself, at `/api/v1/openapi.json`.

Format 0 carries no format number: neither the ciphertext nor the link says
which format it is. [Its limits](#limits-of-format-0) say what that blocks,
and [format 1](#format-1) how the next format lifts them while staying
compatible with this one. Format numbers are unrelated to the version of the
app or the SDK.

## Conventions

- **Primitives** are named as in [libsodium](https://doc.libsodium.org):
  XChaCha20-Poly1305 IETF (`crypto_aead_xchacha20poly1305_ietf`),
  secretstream (`crypto_secretstream_xchacha20poly1305`), Argon2id version
  1.3 (`crypto_pwhash`), SHA-256.
- **Base64** means RFC 4648 §4, with padding, in every JSON field and HTTP
  header. Only the key in the link uses **base64url** (§5), without padding.
- **MessagePack** payloads are maps with string keys. Byte strings are `bin`,
  integers are `int`. Readers must not depend on the order of the keys.
- **Paths** are relative to the instance's origin. The API lives under
  `/api/v1`.
- MUST and MUST NOT are used as in RFC 2119.

## Overview

A note is encrypted in the client with a random key, uploaded, and shared as a
link that carries the key in its fragment. Browsers never send the fragment to
the server, so the instance stores and serves ciphertext it cannot read.

There are two kinds of note, which share the keys and the link:

- **Single-shot**: the whole note is one AEAD ciphertext. For text and small
  files.
- **Chunked**: the note is a secretstream, uploaded and served message by
  message. For large files.

A writer may use either kind within the instance's limits. The SDK switches
to chunked when its estimate of the payload's size exceeds the chunk size.

## Keys

The **base key** is 32 random bytes (`crypto_aead_xchacha20poly1305_ietf_keygen`).
The link carries it.

Without a password, the base key is the **encryption key**.

With a password, the writer draws a 16-byte **salt** and derives the
encryption key with Argon2id:

| Parameter | Value |
|-----------|-------|
| Input | the UTF-8 bytes of `<password>:<base key in base64url>` |
| Salt | the 16 bytes |
| Iterations | 3 (libsodium `OPSLIMIT_MODERATE`) |
| Memory | 268,435,456 bytes, 256 MiB (libsodium `MEMLIMIT_MODERATE`) |
| Parallelism | 1 |
| Version | 0x13 |
| Output | 32 bytes |

The password is used as typed, with no Unicode normalization. The base key in
the input is the same 43-character string as in the link. The writer sends the
salt to the server, which hands it back to readers. Neither the password nor
the base key ever leaves the client: a reader needs both the link and the
password.

## The link

```
<origin>/note/<id>#<key>
```

- `id`: the note's id, assigned by the server. 12 characters from
  `A-Z a-z 0-9 _ -`.
- `key`: the base key in base64url without padding, 43 characters. They
  hold 258 bits for 256, so the last character's two low bits are zero. A
  reader MUST reject a key encoded any other way, as libsodium does. The web
  app also refuses any other shape (`^[A-Za-z0-9_-]{43}$`).

The web app also gives the writer a management link,
`<origin>/note/<id>/manage#<deleteToken>`, which carries the
[delete token](#deletion) in its fragment.

## Payload

The plaintext of a note is a MessagePack map:

| Key | Type | Meaning |
|-----|------|---------|
| `text` | str, optional | The note's text. The SDK refuses more than 102,400 characters (UTF-16 code units). |
| `contentMode` | str, optional | How to present `text`: `"text"`, `"markdown"` or `"secret"` (a password, a key). |
| `files` | array, optional | At most 10 files. |

Each file is a map:

| Key | Type | Meaning |
|-----|------|---------|
| `name` | str | The file name, as the writer gave it. |
| `type` | str | Its MIME type, as the writer gave it. |
| `size` | int | Its length in bytes. |
| `data` | bin | Its bytes. |

The writer leaves out a key rather than writing `nil`, and leaves out `files`
for a note without files. It writes every key of a file, `size` being the
length of `data`, and writes the keys in the order of these tables: `text`,
`contentMode`, `files`, then `name`, `type`, `size`, `data`. A reader does not
depend on that order, but the [test vectors](#test-vectors) match byte for
byte only in it.

A reader SHOULD reject a payload that is not a map, whose keys have the wrong
type, or whose `contentMode` is not one of the three values. The reference
reader checks less: it rejects a `text` that is not a string, an unknown
`contentMode`, a `files` that is not an array, and a file whose `name` or
`type` is not a string or whose `size`, when present, is not a number. It does
not check that the payload is a map, the type of `data`, the number of files,
or that `size` matches the data. It ignores keys it does not know.

## Single-shot notes

### Encryption

1. Encode the payload as MessagePack.
2. Draw a 24-byte nonce.
3. Encrypt with XChaCha20-Poly1305 IETF, under the encryption key and the
   nonce, with empty additional data. The ciphertext is the encrypted bytes
   followed by the 16-byte tag.

### Upload

A note is sent as JSON:

```
POST /api/v1/notes
Content-Type: application/json

{
  "encryptedData": "<base64 ciphertext>",
  "clientNonce": "<base64 nonce>",
  "hasPassword": false,
  "expiresIn": 86400,
  "maxReads": 1,
  "fileCount": 0
}
```

A note with files can also be sent as `multipart/form-data`, which spares the
base64 overhead, and the SDK does so. It has two parts: `metadata`, a JSON
string with the same fields except `encryptedData`, and `data`, the ciphertext
bytes as a file part:

```
POST /api/v1/notes/upload
```

The fields:

| Field | Value |
|-------|-------|
| `hasPassword` | Whether the key was derived from a password. When true, `salt` is required. |
| `salt` | The 16-byte salt, in base64. The server keeps it whatever `hasPassword` says. |
| `expiresIn` | Seconds until the note expires: 300 to 2,592,000, and at most the instance's `maxExpiry`. |
| `maxReads` | Reads before the note is deleted: 0 to 1000, 0 meaning until it expires. Default 1. |
| `fileCount` | The number of files in the payload: 0 to 10, at least 1 for a multipart upload, and at most the instance's `maxFilesPerNote`. The server cannot check it against the ciphertext. It shows it before a note is opened. |
| `clientNonce` | The nonce, in base64, at most 48 characters. |

The server checks neither the salt's length nor the nonce's: with a wrong one,
the note is created and nobody can read it.

Both answer `201` with `{"id", "expiresAt", "deleteToken"}`. A note declared
with `fileCount` 0 is limited to 524,288 bytes of ciphertext, and any request
to the instance's `maxFileSize × maxFilesPerNote` plus 1 MiB. The server keeps
the expiry to the second: `expiresAt` comes back with milliseconds here, and
without them everywhere else.

### Reading

```
GET /api/v1/notes/{id}/raw
```

The body is the ciphertext. The headers carry the rest:

| Header | Value |
|--------|-------|
| `X-Client-Nonce` | The nonce, in base64. |
| `X-Has-Password` | `true` or `false`. |
| `X-Salt` | The salt, in base64, for a password note. |
| `X-File-Count` | `fileCount`. |
| `X-Created-At`, `X-Expires-At` | ISO 8601 timestamps. |

`GET /api/v1/notes/{id}` serves the same note as JSON:
`{"encryptedData", "clientNonce", "hasPassword", "salt"?, "fileCount",
"createdAt", "expiresAt"}`, with the ciphertext in base64, a third larger.

To decrypt, derive the encryption key with the salt when `hasPassword` is
true, and take the base key otherwise, even if a salt comes back. Then open
the ciphertext, decode the MessagePack and check the payload.

## Chunked notes

### Encryption

The writer opens a secretstream under the encryption key. Its 24-byte header
is sent to the server. Every message is pushed with empty additional data, and
its ciphertext is 17 bytes longer than its plaintext. The messages, in order:

1. **The head**: the payload without the file bytes, as MessagePack:
   `text` and `contentMode` as above and, for a note with files, `files` as
   an array of `{name, type, size}` maps that lists every file, empty ones
   included. The head is one message, so it must fit in the chunk size: a
   writer whose head does not fit sends the note single-shot.
2. **The file bytes**: each file in turn, cut into pieces of at most the
   instance's chunk size. A piece never holds bytes of two files, and an empty
   file has no piece.

The last message, and only the last, carries `TAG_FINAL` (3). Every other
message carries `TAG_MESSAGE` (0). A note with no file bytes is a single
message: the head, final.

A reader MUST reject the stream unless the last message carries `TAG_FINAL`
and no other message does. The reference reader takes any other tag for
`TAG_MESSAGE`. A reader MUST reject a head-only stream whose head
declares a file larger than 0 bytes. It joins the pieces, then splits them
into files by the declared sizes, in order, and MUST reject the stream when
they fall short. The reference reader ignores bytes beyond the declared sizes.
It checks the head like a payload.

### Upload

The chunk size is the instance's `chunkSize` (4,194,304 bytes by default). The
server refuses a message whose ciphertext is longer than `chunkSize` plus 17
bytes (`413`), and, at `/init`, a note of more than `maxChunkedFileSize`
divided by `chunkSize` messages, rounded up, head included (`400`). The
server checks the length of neither the stream header nor the salt.

1. Open an upload session:

   ```
   POST /api/v1/notes/upload/init
   Content-Type: application/json

   {
     "streamHeader": "<base64 secretstream header>",
     "clientNonce": "<base64 of 24 random bytes>",
     "chunkCount": 3,
     "hasPassword": false,
     "expiresIn": 86400,
     "maxReads": 1,
     "fileCount": 1
   }
   ```

   `chunkCount` is the number of messages, head included. `clientNonce` is
   not used by chunked notes, but required. The other fields are those of a
   single-shot note. The answer is `201` with `{"uploadId", "expiresAt"}`,
   where `expiresAt` is the session's: it lasts an hour.

2. Send every message, `index` counting from 0 for the head:

   ```
   PUT /api/v1/notes/upload/{uploadId}/chunks/{index}
   Content-Type: application/octet-stream
   X-Chunk-Hash: <lower-case hex SHA-256 of the body>
   ```

   The body is the message's ciphertext. `X-Chunk-Hash` is required: a
   missing or upper-case hash answers `400`. The answer is `200` with
   `{"received": true}`. Sending a message again replaces it.

3. Close the session:

   ```
   POST /api/v1/notes/upload/{uploadId}/complete
   ```

   The answer is `201` with `{"id", "expiresAt", "deleteToken"}`, the expiry
   counting from now, or `400` while a message is missing. The session is
   then gone: completing it again, or sending it a message, answers `404`.

### Reading

```
GET /api/v1/notes/{id}/stream
```

The headers are those of `/raw`, with `X-Stream-Header` (the secretstream
header, in base64) and `X-Chunk-Count` in place of `X-Client-Nonce`. The body
is every message's ciphertext in order, each preceded by its length as a
4-byte unsigned big-endian integer.

## Reading a note

```
GET /api/v1/notes/{id}/exists
```

answers `{"exists": false}` for a note that does not exist or has expired,
and otherwise:

```json
{
  "exists": true,
  "hasPassword": true,
  "fileCount": 1,
  "expiresAt": "2026-11-01T12:00:00.000Z",
  "maxReads": 1,
  "readCount": 0,
  "chunked": false
}
```

It spends no read. `chunked` tells which endpoint serves the note: `/stream`,
or `/raw` and the JSON endpoint. Asking the wrong one answers `400` and spends
no read. `readCount` stays 0 for a note with unlimited reads. Every note
endpoint answers `400` to an id that is not 12 characters of the alphabet
above.

The server spends a read as it serves the ciphertext, once it has loaded the
note from its storage (for a chunked note, the head). The client has not
decrypted anything yet, so a wrong password spends a read. Ask for the
password before reading a note whose `hasPassword` is true.

When the reads spent reach `maxReads`, the server deletes the note. A note
that never existed, has expired, was burned or was deleted answers `404`, the
same way.

A client MUST NOT retry a read on its own: the retry could spend a second
read, or meet a `404` in place of the real error.

## Deletion

```
DELETE /api/v1/notes/{id}
X-Delete-Token: <deleteToken>
```

The delete token is the 32-character token returned at creation. The request
also needs [write authentication](#authentication). The answer is
`{"deleted": true}`, `403` for a wrong token, or `404`.

## Authentication

Reads are open. Creating and deleting a note need one of:

- `Authorization: Bearer <API key>`, with a key the operator configured;
- `X-Cap-Token: <token>`, a single-use proof-of-work token from the
  instance's challenge endpoints under `/api/cap/`, as the web app gets one.

Message uploads and `/complete` need neither: the upload id stands for the
authentication given to `/init`. A refusal answers `401` with
`{"error": "Unauthorized"}`, whatever failed.

## Instance limits

```
GET /api/v1/config
```

answers the limits a client should respect before uploading:

| Field | Meaning |
|-------|---------|
| `maxFileSize` | Sizes the limit on a single-shot upload: `maxFileSize × maxFilesPerNote` plus 1 MiB. |
| `maxFilesPerNote` | The largest `fileCount`. |
| `maxExpiry` | The largest `expiresIn`, in seconds. |
| `chunkSize` | The largest message plaintext of a chunked note, in bytes. |
| `maxChunkedFileSize` | The largest chunked note, in bytes. |

## Errors

Errors answer JSON, `{"error": "<message>"}`. The message is meant for a
developer: tell errors apart by their status.

| Status | Meaning |
|--------|---------|
| 400 | Invalid request, or the wrong read endpoint |
| 401 | Write authentication missing or refused |
| 403 | Wrong delete token |
| 404 | The note, or the upload session, does not exist |
| 409 | A message sent while its upload session was being completed |
| 413 | Too large |
| 415 | A body that is not JSON, or not multipart for `/notes/upload` |
| 429 | Rate limited |
| 500 | Server error, such as a note the server cannot decrypt |
| 507 | The instance's storage quota is full |

## What the server learns

The server never holds a key or a password, so it never sees a note's text,
file names, MIME types or file bytes. It does learn:

- the metadata it is given: `hasPassword`, `fileCount`, `maxReads`, the
  expiry, the salt, and when the note was created and read;
- sizes. A single-shot ciphertext is the MessagePack payload plus 16 bytes,
  which gives the length of the text and of the files together. A chunked
  note shows the size of its head, and, since a piece never holds two files,
  the size of each file.

## Server layer

This section is for operators: a client never sees this layer.

The instance encrypts what it stores again, with AES-256-GCM under its
`SERVER_ENCRYPTION_KEY`: a random 12-byte IV, the 16-byte tag after the
ciphertext, and the ASCII bytes of the note id as additional data, so that a
blob moved to another note fails to decrypt.

- A single-shot note keeps its IV in the database (`notes.server_nonce`, in
  base64) and its ciphertext with the tag in the database
  (`notes.encrypted_data`) for a note without files, or in the storage for a
  note with files.
- A chunked note stores every message as its own object: IV, ciphertext, tag.

## Limits of format 0

- **No format number.** Neither the ciphertext nor the link names its format: the
  read endpoint does. Nothing can change without breaking the links already
  shared.
- **Fixed Argon2id parameters.** They are not stored with the note, so they
  cannot be raised for new notes without breaking the old ones.
- **No normalization.** A password typed in another Unicode form (NFD, as
  some systems produce, rather than NFC) derives another key.
- **No proof of reading.** The server serves the ciphertext to anyone who
  knows the id, before any check of the key: a wrong password spends a read,
  and whoever holds the link can try passwords offline, without limit.
- **Unauthenticated metadata.** `fileCount`, `maxReads` and the expiry are not
  bound to the ciphertext.
- **Exact sizes.** Nothing pads the plaintext.
- **No key separation.** The base key, or the key derived from it, is the
  encryption key, so no other key can be derived from it safely.
- **Two kinds of note, three read endpoints**, and two layouts of the server
  layer.

## Format 1

**Draft.** Instances accept and serve format 1, and the reference SDK reads it,
but writes it only when asked to (`format: 1`). Its bytes may still change
before it is marked final, with a proof of reading and padding: do not write
it outside tests yet. Instances keep reading and accepting format 0
throughout the app's 1.x releases, so links already shared and clients that
only speak format 0 keep working.

What changes from format 0:

- the link and the stored note name their format;
- the encryption key is derived with HKDF, so that other keys can be derived
  from the same secret;
- the Argon2id parameters are stored with the note, and the password is
  normalized to NFC;
- the settings a writer declares travel in one **envelope**, which the
  ciphertext authenticates;
- a reader checks the payload strictly.

The payload, the two kinds of note, the way a chunked note is cut, and every
endpoint not named below are those of format 0.

### Keys

The **link key** `K` is 32 random bytes, as format 0's base key.

With a password, the writer draws a 16-byte salt, picks the Argon2id
parameters, and stretches the password:

```
P = Argon2id(password = UTF-8(NFC(password)), salt, t, m, p = 1, version 0x13, 32 bytes)
```

`NFC` is Unicode Normalization Form C. An empty password is no password. By
default a writer uses t = 3 iterations and m = 262,144 KiB (256 MiB,
libsodium's moderate setting), and records them in the envelope. A reader runs
the parameters the envelope gives, but MUST refuse t outside 1 to 10, or m
outside 65,536 to 1,048,576 KiB (64 MiB to 1 GiB), before running Argon2id.

Then, with HKDF-SHA256 (RFC 5869):

```
IKM = K                      without a password
IKM = K || P                 with one
PRK = HKDF-Extract(salt = none, IKM)
encryption key = HKDF-Expand(PRK, info = "secret/1 enc", 32)
```

`salt = none` is HKDF's default, 32 zero bytes. `info` is ASCII. Other `info`
strings are reserved for keys format 1 will derive from the same PRK.

### The link

```
<origin>/note/<id>#1.<key>
```

`key` is `K` encoded as in format 0: 43 base64url characters. A format 0 key
never holds a `.`, so a reader tells the formats apart by the `1.` prefix,
and SHOULD refuse a malformed format 1 fragment before reading the note.

### The envelope

The envelope holds everything a writer declares besides the ciphertext. The
server reads the note's settings from it, stores it, and serves it back
byte for byte. It is the additional data of every AEAD operation on the note,
so a reader detects any change to it.

| Offset | Bytes | Field |
|--------|-------|-------|
| 0 | 1 | Format: 1 |
| 1 | 1 | Kind: 0 single-shot, 1 chunked |
| 2 | 1 | Key derivation: 0 none, 1 Argon2id with a password |
| 3 | 1 | `fileCount` |
| 4 | 2 | `maxReads`, unsigned big-endian |
| 6 | 4 | `expiresIn` in seconds, unsigned big-endian |
| 10 | 24 | The XChaCha20 nonce (single-shot), or the secretstream header (chunked) |
| 34 | 16 | The salt (key derivation 1 only) |
| 50 | 4 | Argon2id `t`, unsigned big-endian (key derivation 1 only) |
| 54 | 4 | Argon2id `m` in KiB, unsigned big-endian (key derivation 1 only) |

An envelope is 34 bytes without a password, 58 with one. A reader MUST refuse
an envelope whose first byte is not 1, whose kind or key derivation is
unknown, whose length is not the one its key derivation calls for, or whose
Argon2id parameters fall outside the bounds above. It uses the envelope as it
received it, never re-encoded.

The settings mean what they mean in format 0, and the envelope tells the
server nothing format 0's fields do not, the Argon2id parameters aside. The
server refuses (`400`) an
envelope of the wrong kind for the endpoint, or whose settings exceed the
protocol's limits (`fileCount` 0 to 10, at least 1 for a multipart upload,
`maxReads` 0 to 1000, `expiresIn` 300 to 2,592,000), and applies the
instance's limits as to a format 0 note. Envelopes travel in base64.

### Single-shot notes in format 1

1. Encode the payload as MessagePack, as in format 0.
2. Draw a 24-byte nonce and build the envelope with it (kind 0).
3. Encrypt with XChaCha20-Poly1305 IETF under the encryption key and the
   nonce, with the envelope as additional data.

The note is sent with the envelope in place of format 0's fields:

```
POST /api/v1/notes
Content-Type: application/json

{"envelope": "<base64 envelope>", "encryptedData": "<base64 ciphertext>"}
```

or as `multipart/form-data` to `POST /api/v1/notes/upload`, with `metadata`
set to `{"envelope": "<base64 envelope>"}`. The answer is format 0's.

`GET /api/v1/notes/{id}/raw` serves the ciphertext as for format 0, with an
`X-Envelope` header (base64) in place of `X-Client-Nonce` and `X-Salt`. The
JSON endpoint, `GET /api/v1/notes/{id}`, refuses a format 1 note (`400`)
without spending a read.

### Chunked notes in format 1

The writer opens a secretstream under the encryption key and builds the
envelope with its header (kind 1). The messages, their tags and the way the
files are cut are format 0's, but every message is pushed with the envelope
as additional data.

The upload session opens with the envelope and the number of messages:

```
POST /api/v1/notes/upload/init
Content-Type: application/json

{"envelope": "<base64 envelope>", "chunkCount": 3}
```

The messages and `/complete` are sent as in format 0. `GET
/api/v1/notes/{id}/stream` serves the stream as for format 0, with
`X-Envelope` in place of `X-Stream-Header` and `X-Salt`.

### Reading strictly

`GET /api/v1/notes/{id}/exists` answers as for format 0: `hasPassword` comes
from the envelope. A format 1 reader MUST refuse:

- a response without an envelope, which is a format 0 note behind a format 1
  link, or with the envelope of the other kind than the endpoint serves;
- a password note read without a password; a password given for a note
  without one is ignored;
- a payload, or the head of a chunked note, that is not one MessagePack map
  with nothing after it, whose `text` is not a string, whose `contentMode` is
  not one of the three values, or whose `files` is not an array of at most 10
  entries;
- a file whose `name` or `type` is not a string, or whose `size` is not a
  non-negative integer; in a single-shot note, a file whose `data` is not
  `bin` or whose length is not `size`;
- a payload with another number of files than the envelope's `fileCount`;
- in a chunked note, a message before the last whose tag is not `TAG_MESSAGE`,
  a last one whose tag is not `TAG_FINAL`, and file bytes that fall short of
  the declared sizes or exceed them.

A key present with the value `nil` is not absent: `text: nil` is refused. A
reader ignores keys it does not know. It need not check where the file bytes
were cut, nor the length of each message: the tags and the declared sizes are
enough.

A writer writes each key of a map once, as a `str`, strings in valid UTF-8,
and `size` as an `int`. The reference reader keeps the last of a repeated key,
reads an integer key as a string, decodes invalid UTF-8 without refusing it,
and takes a float with an integer value for an integer; another reader may
refuse them.

## Test vectors

[`packages/shared/src/test-vectors/vectors.json`](packages/shared/src/test-vectors/vectors.json)
holds, for format 0:

| Section | What it pins down |
|---------|-------------------|
| `xchacha20poly1305` | The AEAD alone: key, nonce, plaintext, ciphertext. |
| `argon2id` | The password derivation, with its exact input string. |
| `pipeline` | Single-shot notes, from the payload to its MessagePack and its ciphertext, with and without a password and files. |
| `secretstream` | Chunked notes: head, header and every message. The header is random, so these were written once. |
| `encoding` | Base64url keys. |

and, under `format1`:

| Section | What it pins down |
|---------|-------------------|
| `keys` | The key schedule: the link key, the password (one typed in NFD), the stretched password, the PRK and the encryption key. |
| `envelopes` | Envelopes, from their fields to their bytes. |
| `pipeline` | Single-shot notes, from the payload to the ciphertext under its envelope. |
| `secretstream` | Chunked notes. Their envelopes hold a random stream header, so these were written once. |

The file's `version` field counts revisions of the file, not formats. In the
`secretstream` vectors, `headerMsgpack` is the head's plaintext and `header`
the secretstream header, which format 1 vectors carry inside their envelope,
at offset 10. In `format1.envelopes`, `nonce` holds the nonce or the stream
header, and the key derivation is Argon2id when `argon2` is present. Bytes are
in base64 throughout, file `data` included. The `chunkSize` of the
`secretstream` vectors only says where the file bytes are cut: their heads are
longer than it, which an instance with that chunk size would refuse.

The vectors are frozen. The repository checks them against libsodium and
against a second implementation that shares no code with it, OpenSSL through
`node:crypto` (`vectors-openssl.test.ts`), secretstream aside. A new client
should pass all of them.
