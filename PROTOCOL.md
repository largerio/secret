# Secret protocol

This document specifies how a Secret client encrypts a note, what it sends to
an instance, and how it reads a note back. It should be enough to write a
compatible client in any language, without reading the SDK.

The main part describes [format 1](#format-1), which the web app, the SDK and
the command line write. [Format 0](#format-0-legacy), the older format, is
described in an appendix: instances still read and accept it, so that links
already shared keep working. Format numbers have nothing to do with the
version numbers of the app or the SDK.

The reference implementation lives in [`packages/crypto`](packages/crypto/src)
and [`packages/sdk-js`](packages/sdk-js/src). The [test vectors](#test-vectors)
pin every step down to the byte. Each instance also describes its HTTP API at
`/api/v1/openapi.json`.

## Conventions

- **Primitives** use their [libsodium](https://doc.libsodium.org) names:
  XChaCha20-Poly1305 IETF (`crypto_aead_xchacha20poly1305_ietf`),
  secretstream (`crypto_secretstream_xchacha20poly1305`), Argon2id version
  1.3 (`crypto_pwhash`), and SHA-256.
- **Base64** means RFC 4648 §4, with padding, in every JSON field and HTTP
  header. Only the key in the link uses **base64url** (§5), without padding.
- **MessagePack** payloads are maps with string keys. Byte strings are `bin`
  and integers are `int`. Readers must not depend on the order of the keys.
- **Paths** are relative to the instance's origin. The API lives under
  `/api/v1`.
- MUST and MUST NOT are used as in RFC 2119.

## Overview

A client encrypts a note under a random key, uploads the ciphertext, and
shares a link that carries the key in its fragment. Browsers never send the
fragment to the server, so the instance stores and serves ciphertext it
cannot read.

In format 1:

- A note is a single secretstream. Its plaintext, the [body](#the-body), is
  padded to a size class, so the server learns the class but not the size of
  the text or of any file.
- The settings the writer picks travel in an [envelope](#the-envelope), which
  the ciphertext authenticates.
- A note is uploaded [in one request](#in-one-request), or message by message
  in an [upload session](#in-an-upload-session) when it is large.
- Before the server serves anything, a reader [proves](#proof-of-reading)
  that it holds the link, and the password of a password-protected note. A
  wrong password spends no read, and someone who only knows the note's id can
  neither read it nor burn it.

## Format 1

Instances accept format 1 from version 1.6.0. Older instances refuse it with
`400`, so a client that has to write to one uses
[format 0](#format-0-legacy).

### Keys

The **link key** `K` is 32 random bytes
(`crypto_aead_xchacha20poly1305_ietf_keygen`). The [link](#the-link) carries
it.

For a password-protected note, the writer draws a 16-byte salt, picks the
Argon2id parameters, and stretches the password followed by the link key:

```
P = Argon2id(password = UTF-8(NFC(password)) || K, salt, t, m, p = 1, version 0x13, 32 bytes)
```

`NFC` is Unicode Normalization Form C. `UTF-8` encodes the way WHATWG does,
so a lone surrogate becomes U+FFFD. An empty password counts as no password.
Because `K` is part of the input, nobody can run Argon2id over a dictionary
before they know the link, not even someone who holds the salt.

By default, a writer uses t = 3 iterations and m = 262,144 KiB (256 MiB,
libsodium's moderate setting), and records both in the envelope. `m` is in
KiB: libsodium's `memlimit` is m × 1024 bytes.

A reader runs whatever parameters the envelope gives, but it MUST refuse t
outside 1 to 6, or m outside 65,536 to 524,288 KiB (64 to 512 MiB), before
running Argon2id. It runs Argon2id before it can tell whether the envelope
was altered, so these bounds cap what a server, or a writer, can make a
reader spend. The lower bounds matter too. A server could serve an altered
envelope with a new salt and the lightest parameters: the password proof it
gets back still costs at least that much to attack offline, and the attack
would also need `K`.

Then, with HKDF-SHA256 (RFC 5869):

```
IKM = K                      without a password
IKM = K || P                 with one
PRK = HKDF-Extract(salt = none, IKM)
encryption key = HKDF-Expand(PRK, info = "secret/1 enc", 32)
```

`salt = none` is HKDF's default, 32 zero bytes, and `info` is ASCII. The same
secrets give the [proofs](#proof-of-reading) a reader sends:

```
link proof     = HKDF-Expand(HKDF-Extract(salt = none, K), info = "secret/1 link", 32)
password proof = HKDF-Expand(PRK, info = "secret/1 read", 32)      with a password only
link verifier     = SHA-256(link proof)
password verifier = SHA-256(password proof)
```

Without a password, the link proof's PRK is the same as the PRK above.
Proofs and verifiers are 32 bytes each. The `info` strings form a single
namespace across both PRKs, which are the same PRK when there is no
password. Any other string is reserved for keys format 1 may derive later.

Neither the password nor `K` is ever sent. A reader needs both the link and
the password.

### The link

```
<origin>/note/<id>#1.<key>
```

- `id` is the note's id, assigned by the server: 12 characters from
  `A-Z a-z 0-9 _ -`.
- `1.` is the format.
- `key` is `K` in base64url without padding, 43 characters. Those 43
  characters hold 258 bits for 256, so the two low bits of the last one are
  zero. A reader MUST reject a key encoded any other way, as libsodium does.

A [format 0](#format-0-link) key never contains a `.`, so a reader tells the
formats apart by the `1.` prefix. It MUST refuse a malformed format 1
fragment before reading the note. A fragment that starts with another number
and a dot names a format the reader doesn't know, and it MUST refuse that too
before reading the note. Format numbers are written in decimal without
leading zeros, so `01.` names no format and is refused as well.

The web app also gives the writer a management link,
`<origin>/note/<id>/manage#<deleteToken>`, which carries the
[delete token](#deletion) in its fragment.

### The payload

The content of a note is a MessagePack map:

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

The file bytes aren't part of the map: they follow it in the
[body](#the-body).

The writer omits a key rather than writing `nil`, and omits `files` when the
note has no files. It writes every key of a file, in the order of the tables
above: `text`, `contentMode`, `files`, then `name`, `type`, `size`. Readers
don't depend on that order, but the [test vectors](#test-vectors) only match
byte for byte when it is followed. [Reading strictly](#reading-strictly)
lists what a reader refuses.

### The envelope

The envelope holds the settings the writer declares, plus what a reader
needs to derive the key and open the ciphertext. The server reads the note's
settings from it, stores it, and serves it back byte for byte. The envelope
is the additional data of every AEAD operation on the note, so once a reader
has derived the key, it detects any change to the envelope.

The envelope is public. The server serves it to anyone who knows the note's
id, because a reader needs the salt and the Argon2id parameters to derive the
proofs it reads with. It holds nothing derived from the password or from
`K`, and it never will: with such a value, anyone holding the link could test
passwords without reading the note. That's why the verifiers travel next to
the envelope, and are never served.

| Offset | Bytes | Field |
|--------|-------|-------|
| 0 | 1 | Format: 1 |
| 1 | 1 | Key derivation: 0 none, 1 Argon2id with a password |
| 2 | 1 | `fileCount` |
| 3 | 2 | `maxReads`, unsigned big-endian |
| 5 | 4 | `expiresIn` in seconds, unsigned big-endian |
| 9 | 24 | The secretstream header |
| 33 | 16 | The salt (key derivation 1 only) |
| 49 | 4 | Argon2id `t`, unsigned big-endian (key derivation 1 only) |
| 53 | 4 | Argon2id `m` in KiB, unsigned big-endian (key derivation 1 only) |

An envelope is 33 bytes without a password, and 57 bytes with one. A reader
MUST refuse an envelope:

- whose first byte isn't 1;
- whose key derivation is unknown;
- whose length doesn't match its key derivation;
- whose Argon2id parameters fall outside the [bounds above](#keys).

A reader doesn't have to check the settings against the protocol's limits
below, since the server does, but it may. It uses the envelope exactly as it
received it, and never re-encodes it.

The settings:

| Setting | Meaning |
|---------|---------|
| `fileCount` | The number of files in the payload. The server can't check it against the ciphertext, and shows it before a note is opened. |
| `maxReads` | Reads before the note is deleted, 0 meaning until it expires. |
| `expiresIn` | Seconds until the note expires. |

Apart from the settings and the Argon2id parameters, the envelope only holds
the stream header and the salt, which are random. It tells the server
nothing more.

The server refuses an envelope with `400` if a reader would refuse it, or if
its settings exceed the protocol's limits: `fileCount` 0 to 10 (at least 1
for a multipart upload), `maxReads` 0 to 1000, `expiresIn` 300 to 2,592,000.
It also applies the instance's own limits: `expiresIn` at most `maxExpiry`,
and `fileCount` at most `maxFilesPerNote`.

Envelopes travel in base64. A request that carries an `envelope` key is a
format 1 request whatever the value, `null` included, and the server ignores
any [format 0](#single-shot-notes) fields next to it.

### The body

The plaintext of a note is its **body**: the head, then the file bytes, then
padding.

```
body = len(head) || head || file 1 || ... || file n || padding
```

- `len(head)` is the length of the head in bytes, as a 4-byte unsigned
  big-endian integer.
- The **head** is the [payload](#the-payload), encoded as MessagePack. For a
  note with files, `files` lists every file, including empty ones.
- The bytes of each file follow, `size` bytes each, in the order of `files`.
- The **padding** is zero bytes: as many as it takes to bring the body's
  length up to the **size class** of its unpadded length,
  `L = 4 + len(head) + the sum of the file sizes`.

```
size class(L) = 4096                     when L <= 4096
size class(L) = ceil(L / 2^z) * 2^z      otherwise, where E = floor(log2(L)),
                                         S = floor(log2(E)) + 1, z = E - S
```

This is Padmé (Nikitin et al., *Reducing Metadata Leakage from Encrypted
Files and Communication with PURBs*, PETS 2019) with a floor. Every body up
to 4,096 bytes has the same length, whether it holds a password or a private
key. A longer body is at most 6.25% longer than its content, and at most
3.125% from 65,536 bytes on.

`E` is the bit length of `L`, minus one. Compute it with integers: a
floating-point `log2` can round up just below a power of two. For example,
4,097 bytes of content give a body of 4,352 bytes, and 1,000,000 bytes give
1,015,808. A length is a size class when it is its own size class.

### Messages

The writer opens a secretstream under the encryption key, and builds the
envelope with the stream's header. It then cuts the body into messages of `C`
bytes, a length of its choosing. Every message holds `C` bytes except the
last, which holds the remaining 1 to `C` bytes. A body sent as a single
message uses `C` equal to the body's length.

Every message is pushed with the envelope as additional data, and its
ciphertext is 17 bytes longer than its plaintext. The last message, and only
the last, carries `TAG_FINAL` (3). Every other message carries `TAG_MESSAGE`
(0).

The cut ignores what the body contains: one message can hold the end of the
head and the start of a file, or bytes from two files.

### Writing a note

A note is uploaded either as one message in one request, or message by
message in an upload session. A writer that uses a session SHOULD use the
instance's `chunkSize` as `C`, so that its messages look like every other
writer's. The reference SDK sends a note without files as one message. It
sends a note with files as one message when the body fits in `C`, and in a
session otherwise.

#### In one request

The request carries the envelope, the [verifiers](#keys), and the single
message as the ciphertext:

```
POST /api/v1/notes
Content-Type: application/json

{
  "envelope": "<base64 envelope>",
  "linkVerifier": "<base64>",
  "passwordVerifier": "<base64>",
  "encryptedData": "<base64 message>"
}
```

A note with files can also be sent as `multipart/form-data` to
`POST /api/v1/notes/upload`, which avoids the base64 overhead. The `metadata`
part is a JSON string holding the same object without `encryptedData`, and
the `data` part is the message, as a file.

Send `passwordVerifier` only for a password-protected note. The server
refuses the write with `400` if:

- the link verifier is missing;
- the note has a password and the password verifier is missing;
- the note has no password and a password verifier is present.

A key counts as present whatever its value, `null` included. Each verifier is
32 bytes.

Both endpoints answer `201` with `{"id", "expiresAt", "deleteToken"}`. The
size limits:

- A note without files is limited to 524,288 bytes of ciphertext.
- Any request is limited to the instance's `maxFileSize × maxFilesPerNote`,
  plus 1 MiB.
- A message too long for a read to [frame](#proof-of-reading) is refused
  with `413`.

The server keeps expiry times to the second: every `expiresAt`, and
`X-Expires-At`, ends in `.000Z`.

#### In an upload session

The chunk size is the instance's `chunkSize`, 4,194,304 bytes by default. A
message holds at most `chunkSize` bytes of the body, and the server refuses
with `413` any message whose ciphertext is longer than `chunkSize` plus 17
bytes.

1. Open the session:

   ```
   POST /api/v1/notes/upload/init
   Content-Type: application/json

   {"envelope": "<base64 envelope>", "linkVerifier": "<base64>", "chunkCount": 3}
   ```

   Add `passwordVerifier` for a password-protected note. `chunkCount` is the
   number of messages. The server answers `201` with
   `{"uploadId", "expiresAt"}`, where `expiresAt` is the session's own
   expiry: a session lasts an hour.

   The instance's `maxChunkedFileSize` limits the files, not the padding. A
   session may announce as many messages as the padded body takes for that
   many bytes of files, with 524,288 bytes of room for the head
   ([Instance limits](#instance-limits)). More is refused with `400`.

2. Send each message, with `index` counting from 0:

   ```
   PUT /api/v1/notes/upload/{uploadId}/chunks/{index}
   Content-Type: application/octet-stream
   X-Chunk-Hash: <lower-case hex SHA-256 of the body>
   ```

   The body is the message's ciphertext. `X-Chunk-Hash` is required: the
   server answers `400` if it is missing, upper-case, or doesn't match the
   body. Otherwise it answers `200` with `{"received": true}`. Sending a
   message again replaces it, once the first upload has been answered. While
   the message is still being written, sending it again answers `409`.

3. Close the session, with an empty body:

   ```
   POST /api/v1/notes/upload/{uploadId}/complete
   ```

   The server answers `201` with `{"id", "expiresAt", "deleteToken"}`, the
   expiry counting from now. It answers `400` while a message is missing,
   and `409` while a message is still being written, so only complete once
   every upload has been answered. After that, the session is gone:
   completing it again, or sending it a message, answers `404`.

Everything `/init` needs is known before the first message is encrypted. The
reference SDK opens the session first, so that a refused session costs no
encryption, then encrypts each message as it uploads it.

The server checks the lengths it sees against the rules of the body. It
refuses with `400`:

- a note whose body length (the messages' total length, minus 17 bytes per
  message) isn't a size class;
- in a session, a note whose messages before the last differ in length, or
  whose last message is longer than the first or holds no byte of the body.

It checks a session at `/complete`. A refused session stays open, like one
with a missing message, until it is completed or expires.

### Proof of reading

Reading a note takes two steps, and the server serves nothing until the
reader has proved what it holds.

1. The reader asks for the note's metadata, which spends no read:

   ```
   GET /api/v1/notes/{id}/exists
   ```

   The answer is `200` whether the note exists or not. A note that doesn't
   exist or has expired gives `{"exists": false}`. Otherwise:

   ```json
   {
     "exists": true,
     "hasPassword": true,
     "fileCount": 1,
     "expiresAt": "2026-11-01T12:00:00.000Z",
     "maxReads": 1,
     "readCount": 0,
     "chunked": false,
     "envelope": "<base64 envelope>",
     "passwordAttemptsLeft": 5
   }
   ```

   `envelope` is the note's envelope. `passwordAttemptsLeft` only appears for
   a password-protected note, and goes from 5 down to 1. `readCount` stays at
   0 for a note with unlimited reads. The other fields come from the envelope
   (see [Reading strictly](#reading-strictly)).

2. The reader checks the envelope, derives the keys and the proofs from it,
   and sends the proofs:

   ```
   POST /api/v1/notes/{id}/reads
   Content-Type: application/json

   {"linkProof": "<base64>", "passwordProof": "<base64>"}
   ```

Send `passwordProof` only for a password-protected note; the server ignores a
well-formed one on a note without a password. If a proof isn't 32 bytes in
base64, the server answers `400` and counts nothing.

Before spending anything, the server checks:

- that the note exists. If it doesn't, the answer is `404`, as for every
  read.
- that it is a format 1 note. A format 0 note gives `400`.
- the link proof, against the note's link verifier. A wrong one gives `403`
  and counts nothing, since nobody without `K` can guess it.
- for a password-protected note, that a password proof was sent (`400`
  otherwise), and that it matches the password verifier. A wrong one gives
  `403` and counts as a failed attempt.

Failed attempts are counted over the note's whole life. A successful read
doesn't reset them, and wrong passwords sent at the same time each count.
The **fifth** failed attempt deletes the note, as if it had been burned, and
answers `403` like the others.

Both refusals answer `403`, and their [code](#errors) tells them apart:
`wrong_link_proof` or `wrong_password`. A `403` without a code isn't a
refused proof. The answer doesn't say whether the note is gone; `/exists`
does, through `passwordAttemptsLeft`, or with `{"exists": false}` once the
note is deleted.

Once the proofs check out, the server serves the note. It spends a read as
soon as it has loaded the first message. The answer is `200`, with
`Content-Type: application/octet-stream`. The body holds every message's
ciphertext in order, each preceded by its length as a 4-byte unsigned
big-endian integer, whether the note was uploaded in one request or in a
session. A message can therefore be at most 4,294,967,295 bytes long, which
is why an instance's `chunkSize` stays 17 bytes below that. The headers
carry the rest:

| Header | Value |
|--------|-------|
| `X-Has-Password` | `true` or `false`. |
| `X-File-Count` | `fileCount`. |
| `X-Created-At`, `X-Expires-At` | ISO 8601 timestamps. |
| `X-Chunk-Count` | The number of messages. |

For a note uploaded in one request, `Content-Length` gives the body's length
(4 bytes, plus the message). For a session, the length isn't known before the
note is read.

When the reads spent reach `maxReads`, the server deletes the note. A note
that never existed, has expired, was burned or was deleted answers `404`, and
nothing tells these cases apart. Every note endpoint answers `400` to an id
that isn't 12 characters from the alphabet above.

A client MUST NOT retry a read on its own. A retry could spend a second read,
or get a `404` instead of the real error.

The reader opens the messages with the envelope it derived the proofs from.
The [format 0 reads](#format-0-reads) answer `400` to a format 1 note without
spending a read, so a client that only knows format 0 can never spend one by
mistake. The link decides which format the reader reads: a note behind a link
of the other format is refused, not opened.

### Reading strictly

In `/exists`, the settings of a format 1 note come from its envelope:
`hasPassword`, `fileCount`, `maxReads`, and `expiresAt` (from `expiresIn`).
`chunked` is always false. A format 1 note is read the same way however it
was uploaded, and the field would tell anyone who knows the id whether the
note went up in a session, which hints at its size. A reader relies on the
envelope, which the ciphertext authenticates, not on these fields.

Before sending a proof, a format 1 reader MUST refuse:

- an `/exists` answer without an envelope, or with an envelope a reader would
  refuse;
- to read a password-protected note without a password. A password given for
  a note without one is ignored.

After reading the note, it MUST refuse:

- a note with no message, a message before the last whose tag isn't
  `TAG_MESSAGE`, or a last message whose tag isn't `TAG_FINAL`;
- a body shorter than 4 bytes, or shorter than 4 bytes plus the head's
  length;
- a head that isn't exactly one MessagePack map filling its length (an
  extension type, a timestamp included, isn't a map), or whose `text` isn't
  a string, whose `contentMode` isn't one of the three values, or whose
  `files` isn't an array of at most 10 entries;
- a file that isn't a map, whose `name` or `type` isn't a string, or whose
  `size` isn't a non-negative integer, a missing key included;
- a head whose number of files differs from the envelope's `fileCount`;
- file sizes that add up to more than the bytes after the head;
- a body whose length isn't the size class of `L`, or whose padding contains
  a byte other than zero.

A key present with the value `nil` isn't absent, so `text: nil` is refused.
An empty `files` means a note without files. A reader ignores keys it doesn't
know. It doesn't need to check the length of each message: the server does,
and the tags and the body's length are enough.

A reader MUST NOT show any part of the payload before it has opened the last
message and checked the body: only then does it know the note is whole. A
reader that writes files out as the messages open, so as not to hold a large
note in memory, keeps what it writes out of sight, and discards it unless the
body checks out. The reference SDK closes the stream it writes each file to
once the body checks out, and aborts it otherwise.

A writer writes each key of a map once, as a `str`. Strings are valid UTF-8
(a lone surrogate is written as U+FFFD), and `size` is an `int`. Each value
takes the shortest form MessagePack has for it, as common libraries do; the
heads in the vectors only match byte for byte when it does.

A reader MUST either refuse a map that repeats a key, or keep its last value,
as the reference reader does. An integer is a MessagePack `int`, but a
reader may also accept a float with an integer value, as the reference reader
does. The reference reader also reads an integer key as a string, and
decodes invalid UTF-8 without refusing it; another reader may refuse both. It
refuses a `__proto__` key and a key that is neither a string nor a number,
which no writer writes; another reader may refuse them too.

## Deletion

```
DELETE /api/v1/notes/{id}
X-Delete-Token: <deleteToken>
```

The delete token is the 32-character token returned when the note was
created. The request also needs [write authentication](#authentication). The
server answers `{"deleted": true}`, `403` for a wrong token, or `404`.

## Authentication

Reads need no authentication: a format 1 read [proves](#proof-of-reading)
that it holds the link instead. Creating or deleting a note needs one of:

- `Authorization: Bearer <API key>`, with a key the operator configured;
- `X-Cap-Token: <token>`, a single-use token the instance gives in exchange
  for a [proof of work](#proof-of-work). This is how the web app and the
  command line write.

Uploading messages and calling `/complete` need neither: the upload id
stands for the authentication given to `/init`. A refusal answers `401`
(`unauthorized`), whatever the reason.

### Proof of work

The proof of work is [Cap](https://capjs.js.org)'s, served by the instance
under `/api/cap/` with `@cap.js/server` 4. It is Cap's format, not part of
this protocol: it has no version number, its paths aren't versioned, and a new
release of Cap may change it. A contract test
([`proofOfWork.test.ts`](apps/api/src/__tests__/proofOfWork.test.ts)) runs
the command line's solver against the instance, and fails if the two drift
apart.

A client asks for a challenge, solves it, and redeems the solutions for a
token. To get a challenge:

```
POST /api/cap/challenge
```

with no body. The instance answers `200`:

```json
{
  "challenge": { "c": 50, "s": 32, "d": 4 },
  "token": "0123456789abcdef0123456789abcdef0123456789abcdef01",
  "expires": 1793901021064
}
```

| Field | Meaning |
|-------|---------|
| `challenge.c` | The number of challenges: the instance's `CAP_CHALLENGE_COUNT`, 50 by default. |
| `challenge.s` | The length of a salt, in hex characters: 32. |
| `challenge.d` | The difficulty, the length of a target in hex characters: the instance's `CAP_DIFFICULTY`, 1 to 6, 4 by default. |
| `token` | The challenge's id: 50 lowercase hex characters. |
| `expires` | When the challenge expires, in milliseconds since the Unix epoch: 10 minutes after it was served. |

Challenge `i`, for `i` from 1 to `c`, has a salt and a target:

```
salt_i   = prng(token ‖ i, s)
target_i = prng(token ‖ i ‖ "d", d)
```

where `i` is written in decimal and `‖` concatenates strings. `prng(seed, n)`
is Cap's generator. It works on 32-bit unsigned integers, with every
operation modulo 2^32:

1. `h` is the FNV-1a hash of the seed's ASCII bytes: start with
   `h = 2166136261` (`0x811c9dc5`), then for each byte `b`,
   `h = (h XOR b) × 16777619`.
2. Until the output holds `n` characters: `h ^= h << 13`, `h ^= h >> 17`,
   `h ^= h << 5` (xorshift32, where `>>` is a logical shift), then append `h`
   as 8 lowercase hex digits, zero-padded.
3. Cut the output to its first `n` characters.

A solution to challenge `i` is an integer `n_i ≥ 0` such that the SHA-256 of
the ASCII bytes of `salt_i ‖ n_i` (with `n_i` in decimal, without leading
zeros), written in lowercase hex, starts with `target_i`. Each try succeeds
with probability 16^−d. At the default difficulty, a challenge takes 65,536
tries on average, and all 50 take 3.3 million, about a second on one core.
Any solution is accepted; the web app and the command line count up from 0.

The solutions are redeemed as JSON numbers, in the order of `i`:

```
POST /api/cap/redeem
Content-Type: application/json

{"token": "<the challenge's token>", "solutions": [20759, 12490, …]}
```

The instance answers `200`:

```json
{
  "success": true,
  "token": "a5fd561392de249f:7bc090f523cca7ae2b380e6ac8e113",
  "expires": 1793901621064
}
```

`token` is the write token: 16 hex characters, a `:`, then 30 more. It
expires 20 minutes after it was issued, at `expires`. A wrong solution, an
unknown or expired challenge, or a malformed body answers `400` with Cap's
own `{"success": false, "message": "<why>"}`, not with problem details. A
well-formed `/redeem` spends the challenge whether the solutions are right or
wrong, so each challenge can only be redeemed once.

The write token goes in `X-Cap-Token`, and is good for one write. The
instance deletes it as soon as it has checked it, before looking at the rest
of the request, so a write refused afterwards (by validation, say) has still
spent it. Using it a second time answers `401`. Challenges and tokens live in
the instance's memory, so a restart forgets them.

`/api/cap/challenge` and `/api/cap/redeem` share a rate limit, counted per
address separately from the note endpoints: 60 requests a minute, multiplied
by the instance's `RATE_LIMIT_MULTIPLIER`. A write by proof of work uses two
of them. Beyond that, both answer `429` (`rate_limited`) as problem details,
with `Retry-After`.

The instance chooses `c` and `d`, and so how long a client has to work. A
client SHOULD bound what it accepts. The command line refuses a challenge
with `c` above 1,024, `s` above 64, `d` above 6, or `c × 16^d` above 2^27
(134,217,728), and gives up on a challenge after `64 × 16^d` tries.

For example, with the token above and the default `c`, `s` and `d`, the seed
of `salt_1` is `0123456789abcdef0123456789abcdef0123456789abcdef011`. Its
FNV-1a hash is `0x76137c29`, and the first xorshift32 output from it is
`0x2b5c4ca2`. The first two challenges, with their smallest solutions:

| `i` | `salt_i` | `target_i` | `n_i` | SHA-256 of `salt_i ‖ n_i` |
|-----|----------|------------|-------|---------------------------|
| 1 | `2b5c4ca2fbc3e5066b0fb0573da6c475` | `b948` | 20759 | `b948954ef5a255fac7e357ec97ba8b9eca5ed9879b2e33d441fad0030dc00674` |
| 2 | `a252484e802441830a9094a918b2adcb` | `105e` | 12490 | `105eadbd77d3dec19ca1ea80425e8fe2ef82e8e141e3847c309cd6d096060799` |

## Instance limits

```
GET /api/v1/config
```

returns the limits a client should respect before uploading:

| Field | Meaning |
|-------|---------|
| `maxFileSize` | Sets the size limit of a note sent in one request: `maxFileSize × maxFilesPerNote`, plus 1 MiB. |
| `maxFilesPerNote` | The highest `fileCount`. |
| `maxExpiry` | The highest `expiresIn`, in seconds. |
| `chunkSize` | The largest message plaintext in an upload session, in bytes. A positive integer, no larger than `maxChunkedFileSize`, and no larger than 4,294,967,278, so that a message's length, its 17-byte tag included, fits in 4 bytes. |
| `maxChunkedFileSize` | The most file bytes a note sent in a session can carry. It limits the files, not what the format adds: a session may announce the messages of the padded body for that many bytes of files, plus 524,288 bytes of room for the head. In format 0, a session adds a head message and one message started per file. |

## Errors

Errors are [problem details](https://www.rfc-editor.org/rfc/rfc9457)
objects, served as `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "code": "wrong_password",
  "detail": "Wrong password",
  "error": "Wrong password"
}
```

`code` names the error and doesn't change between releases: use it to tell
errors apart. `detail` is meant for developers, and may change. `error`
repeats `detail`, for clients written before codes existed. A `500` also
carries `errorId`, which the instance logs alongside the error.

An answer without a `code` doesn't come from the instance, but from
something in front of it: a reverse proxy, a firewall or a CDN. So a `403`
without a code isn't a wrong proof. A client that gets a code it doesn't
know falls back on the status.

| Code | Status | Meaning |
|------|--------|---------|
| `invalid_request` | 400 | A request that doesn't match its endpoint, including a note id that isn't 12 characters from the alphabet above |
| `note_format_mismatch` | 400 | A read of another format than the note's, which spends nothing |
| `note_is_chunked` | 400 | `/raw` or the JSON endpoint asked for a chunked note |
| `note_is_single_shot` | 400 | `/stream` asked for a single-shot note |
| `password_proof_missing` | 400 | A read of a password-protected note without its password proof |
| `note_not_padded` | 400 | A format 1 note whose message lengths don't fit a [padded body](#the-body) |
| `expiry_above_limit` | 400 | `expiresIn` above the instance's `maxExpiry` |
| `too_many_files` | 400 | `fileCount` above the instance's `maxFilesPerNote` |
| `too_many_chunks` | 400 | A `chunkCount` above what the instance's `maxChunkedFileSize` allows |
| `upload_incomplete` | 400 | `/complete` while a message is missing |
| `chunk_out_of_range` | 400 | A message index outside the session's `chunkCount` |
| `chunk_empty` | 400 | An empty message |
| `chunk_hash_mismatch` | 400 | A message whose `X-Chunk-Hash` is missing, upper-case, or doesn't match it |
| `unauthorized` | 401 | Write authentication missing or refused |
| `wrong_link_proof` | 403 | A format 1 read with a wrong link proof, which counts nothing |
| `wrong_password` | 403 | A format 1 read with a wrong password proof, which counts as a failed attempt |
| `wrong_delete_token` | 403 | A deletion with the wrong token |
| `not_found` | 404 | No such endpoint |
| `note_not_found` | 404 | The note doesn't exist, has expired, or was burned or deleted |
| `upload_not_found` | 404 | The upload session doesn't exist, has expired, or was completed |
| `method_not_allowed` | 405 | `HEAD` on a read |
| `upload_already_completed` | 409 | A message sent while its session was being completed |
| `chunk_in_flight` | 409 | A message sent again, or `/complete`, while a message of the session is still being written |
| `payload_too_large` | 413 | A request body above the instance's limits |
| `note_too_large` | 413 | A note without files above 524,288 bytes of ciphertext, or a format 1 message too long for a read to frame |
| `chunk_too_large` | 413 | A message above the instance's `chunkSize` |
| `unsupported_media_type` | 415 | A body that isn't JSON, or isn't multipart for `/notes/upload` |
| `rate_limited` | 429 | Too many requests from this address |
| `internal_error` | 500 | A server error |
| `note_corrupted` | 500 | A note the server can't open |
| `upload_corrupted` | 500 | An upload session the server can't read |
| `storage_quota_exceeded` | 507 | The instance's storage quota is full |

A `429` carries `Retry-After`, in seconds. Requests are counted per address
and per kind (creates, reads, `/exists`, message uploads, and the
[proof of work](#proof-of-work)), writes with an API key included. A refused
request spends nothing, so a message refused in the middle of an upload
session can be sent again once the wait is over.

## What the server learns

The server never holds a key or a password, so it never sees a note's text,
file names, MIME types or file bytes. It does learn:

- **The metadata it is given**: whether the note has a password,
  `fileCount`, `maxReads`, the expiry, the salt and the Argon2id parameters,
  and when the note was created and read.
- **The verifiers, the proofs readers send, and how many wrong passwords were
  tried.** A proof is an HKDF output separate from the key, and a verifier is
  its SHA-256. Without `K`, they reveal nothing about the key or the
  password. But anyone who holds a note's proofs can get its ciphertext
  served, and anyone who also holds `K` can test passwords offline against a
  password proof or verifier, at the cost of Argon2id, just as against the
  ciphertext. Treat them as secrets: a proxy that logs request bodies must not
  keep them.
- **Sizes**: the [size class](#the-body) of the body, and the length of its
  messages, which the writer chose. Every note up to 4,096 bytes looks the
  same, and a larger one is known to within 6.25%. A format 0 note reveals
  more: in one piece, the combined length of its text and files, to within a
  few bytes; chunked, the size of its head and of each file.

## Server layer

This section is for operators: clients never see this layer.

The instance encrypts what it stores a second time, with AES-256-GCM under
its `SERVER_ENCRYPTION_KEY`. Each blob gets a random 12-byte IV, the 16-byte
tag goes after the ciphertext, and the ASCII bytes of the note id are the
additional data, so a blob moved to another note fails to decrypt.

- A note uploaded in one request, like a format 0 single-shot note, keeps its
  IV in the database (`notes.server_nonce`, in base64). Its ciphertext and
  tag go in the database too (`notes.encrypted_data`) when the note has no
  files, and in storage when it has some. For a format 1 note, the
  ciphertext is its one message.
- A note uploaded in a session, like a format 0 chunked note, stores each
  message as its own object: IV, ciphertext, tag.

Format 1 verifiers aren't stored as they came, but sealed:

```
verifier key = HKDF-SHA256(SERVER_ENCRYPTION_KEY, salt = none, info = "secret/server verifier", 32)
sealed       = HMAC-SHA256(verifier key, role || 0x00 || note id || SHA-256(envelope) || verifier)
```

`role` is the ASCII string `link` or `password`, and the note id is its 12
ASCII characters. As a result, a copy of the database without the key gives
nothing to test passwords against, even to someone who holds the link. And
someone who can write to the database, but doesn't have the key, can't swap
one verifier for the other or rewrite the envelope and still get the note
served.

The server counts a password attempt before it compares the proof, and gives
it back if the proof matches. A wrong password and a right one then cost the
same writes, so a database that refuses writes tells a reader nothing.

## Test vectors

[`packages/shared/src/test-vectors/vectors.json`](packages/shared/src/test-vectors/vectors.json)
holds, under `format1`:

| Section | What it pins down |
|---------|-------------------|
| `keys` | The key schedule: the link key, the password (one typed in NFD), the stretched password, the PRK, the encryption key, the proofs and their verifiers. |
| `envelopes` | Envelopes, from their fields to their bytes. |
| `sizeClasses` | Lengths and their size class: the floor, and either side of powers of two. |
| `notes` | Notes, from the payload to the head, the body and the messages. |
| `invalid` | What a reader MUST refuse: fragments, envelopes, and notes whose messages break a rule of the stream or of the body, each with the key that opens it and the rule it breaks. |

and, for [format 0](#format-0-legacy), at its top level:

| Section | What it pins down |
|---------|-------------------|
| `xchacha20poly1305` | The AEAD alone: key, nonce, plaintext, ciphertext. |
| `argon2id` | The password derivation, with its exact input string. |
| `pipeline` | Single-shot notes, from the payload to its MessagePack and its ciphertext, with and without a password and files. |
| `secretstream` | Chunked notes: head, header and every message. The header is random, so these were written once. |
| `encoding` | Base64url keys. |

The file's `version` field counts revisions of the file, not formats. Bytes
are in base64 throughout, file `data` included.

- In `format1.envelopes`, the key derivation is Argon2id when `argon2` is
  present. A format 1 note carries its stream header inside its envelope, at
  offset 9.
- The `messageSize` of a `format1.notes` vector is its `C`. One vector cuts
  its body every 1,001 bytes, which shows libsodium's MAC padding (the text's
  length modulo 16, not the padding RFC 8439 uses). Another fills its size
  class exactly, without padding.
- Each `format1.invalid.notes` vector breaks exactly one rule, named by its
  `rule` field, in the order of [Reading strictly](#reading-strictly):
  `decryption` (its messages don't open), `stream` (their tags), `body` (the
  head's length), `head`, `file`, `file-count`, `file-sizes`, or `padding`
  (the size class and the zeros).
- A writer draws its stream header at random, but the format 1 vectors fix
  it. From a header, libsodium's
  `crypto_secretstream_xchacha20poly1305_init_pull` builds the same state as
  a writer that drew it, and that state can push as well as pull.
- In the format 0 `secretstream` vectors, `headerMsgpack` is the head's
  plaintext and `header` the secretstream header. Their `chunkSize` only says
  where the file bytes are cut: their heads are longer than it, which an
  instance with that chunk size would refuse.

The vectors are frozen. The repository checks them against libsodium, and
against a second implementation that shares no code with it: OpenSSL through
`node:crypto` (`vectors-openssl.test.ts`). A new client should pass all of
them.

## Format 0 (legacy)

Format 0 is the format that came before format 1. Instances read and accept
it throughout the app's 1.x releases, so that links already shared, and
clients that only speak format 0, keep working. The SDK still writes it when
asked (`format: 0`), and so does the command line (`--format 0`), for
instances older than 1.6.0. A new client doesn't need to write it, but a
reader that opens links written by others may come across it.

Format 0 has no format number. Neither the ciphertext nor the link says which
format it is: the read endpoint does. Its [limits](#limits-of-format-0) are
what format 1 fixes.

A format 0 note comes in one of two kinds, which share the same keys and
link:

- **Single-shot**: the whole note is one AEAD ciphertext. Used for text and
  small files.
- **Chunked**: the note is a secretstream, uploaded and served message by
  message. Used for large files.

A writer may use either kind within the instance's limits. The SDK switches
to chunked when its estimate of the payload's size exceeds the chunk size.

### Format 0 keys

The **base key** is 32 random bytes
(`crypto_aead_xchacha20poly1305_ietf_keygen`), carried by the link.

Without a password, the base key is the **encryption key**.

With a password, the writer draws a 16-byte **salt**, and derives the
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
the input is the same 43-character string as in the link. The writer sends
the salt to the server, which hands it back to readers. Neither the password
nor the base key ever leaves the client, so a reader needs both the link and
the password.

### Format 0 link

```
<origin>/note/<id>#<key>
```

`id` is the same as in [format 1](#the-link). `key` is the base key in
base64url without padding, 43 characters, encoded like a format 1 key. A
reader MUST reject a key encoded any other way before reading the note. A
format 0 read spends a read whatever the key, so a key cut short in transit
would otherwise burn the note unread. The web app also refuses any other
shape (`^[A-Za-z0-9_-]{43}$`).

### Format 0 payload

The payload is the same as [format 1's](#the-payload), except that a
single-shot note also carries each file's bytes. A file then has a fourth
key, `data` (bin), written after `size`, and `size` is the length of `data`.

A reader SHOULD reject a payload that isn't a map, whose keys have the wrong
type, or whose `contentMode` isn't one of the three values. The reference
reader checks less. It rejects a `text` that isn't a string, an unknown
`contentMode`, a `files` that isn't an array, and a file whose `name` or
`type` isn't a string, or whose `size`, when present, isn't a number. It
doesn't check that the payload is a map, the type of `data`, the number of
files, or that `size` matches the data. It ignores keys it doesn't know.

### Single-shot notes

To encrypt a note:

1. Encode the payload as MessagePack.
2. Draw a 24-byte nonce.
3. Encrypt with XChaCha20-Poly1305 IETF, under the encryption key and the
   nonce, with empty additional data. The ciphertext is the encrypted bytes
   followed by the 16-byte tag.

The note is sent as JSON:

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

A note with files can also be sent as `multipart/form-data` to
`POST /api/v1/notes/upload`, as the SDK does. The `metadata` part is a JSON
string with the same fields except `encryptedData`, and the `data` part holds
the ciphertext bytes, as a file.

| Field | Value |
|-------|-------|
| `hasPassword` | Whether the key was derived from a password. When true, `salt` is required. |
| `salt` | The 16-byte salt, in base64. The server keeps it whatever `hasPassword` says. |
| `expiresIn` | Seconds until the note expires: 300 to 2,592,000, and at most the instance's `maxExpiry`. |
| `maxReads` | Reads before the note is deleted: 0 to 1000, 0 meaning until it expires. 1 by default. |
| `fileCount` | The number of files in the payload: 0 to 10, at least 1 for a multipart upload, and at most the instance's `maxFilesPerNote`. The server can't check it against the ciphertext, and shows it before a note is opened. |
| `clientNonce` | The nonce, in base64, at most 48 characters. |

The server checks neither the salt's length nor the nonce's: with a wrong
one, the note is created, but nobody can read it. The answer and the size
limits are the same as for a format 1 note sent
[in one request](#in-one-request).

To read the note:

```
GET /api/v1/notes/{id}/raw
```

The body is the ciphertext, and the headers carry the rest:

| Header | Value |
|--------|-------|
| `X-Client-Nonce` | The nonce, in base64. |
| `X-Has-Password` | `true` or `false`. |
| `X-Salt` | The salt, in base64, for a password-protected note. |
| `X-File-Count` | `fileCount`. |
| `X-Created-At`, `X-Expires-At` | ISO 8601 timestamps. |

`GET /api/v1/notes/{id}` serves the same note as JSON,
`{"encryptedData", "clientNonce", "hasPassword", "salt"?, "fileCount",
"createdAt", "expiresAt"}`, with the ciphertext in base64, which makes it a
third larger.

To decrypt, derive the encryption key with the salt when `hasPassword` is
true, and use the base key otherwise, even if a salt comes back. Then open
the ciphertext, decode the MessagePack, and check the payload.

### Chunked notes

The writer opens a secretstream under the encryption key, and sends its
24-byte header to the server. Every message is pushed with empty additional
data, and its ciphertext is 17 bytes longer than its plaintext. The messages
come in this order:

1. **The head**: the payload without the file bytes, encoded as MessagePack
   like the format 1 [head](#the-body). The head is a single message, so it
   has to fit in the chunk size. A writer whose head doesn't fit sends the
   note single-shot instead.
2. **The file bytes**: each file in turn, cut into pieces of at most the
   instance's chunk size. A piece never holds bytes from two files, and an
   empty file has no piece.

The last message, and only the last, carries `TAG_FINAL` (3). Every other
message carries `TAG_MESSAGE` (0). A note with no file bytes is a single
message: the head, marked final.

A reader MUST reject the stream unless the last message, and no other,
carries `TAG_FINAL`. The reference reader treats any other tag as
`TAG_MESSAGE`. A reader MUST reject a head-only stream whose head declares a
file larger than 0 bytes. It joins the pieces, splits them into files by the
declared sizes, in order, and MUST reject the stream if the bytes run short.
The reference reader ignores bytes beyond the declared sizes. It checks the
head like a payload.

The note is uploaded in an [upload session](#in-an-upload-session), opened
with format 0's fields:

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

`chunkCount` is the number of messages, head included. `clientNonce` isn't
used by chunked notes, but it is required. The other fields are those of a
single-shot note. `/init` refuses with `400` a note of more than
`maxChunkedFileSize` divided by `chunkSize` messages, rounded up, head
included. The server checks the length of neither the stream header nor the
salt. Messages and `/complete` work as in format 1.

To read the note:

```
GET /api/v1/notes/{id}/stream
```

The headers are those of `/raw`, with `X-Stream-Header` (the secretstream
header, in base64) and `X-Chunk-Count` instead of `X-Client-Nonce`. The body
holds every message's ciphertext in order, each preceded by its length: the
same framing as a format 1 note [served](#proof-of-reading) after its proofs.

### Format 0 reads

`/exists` answers as for a format 1 note, without `envelope` or
`passwordAttemptsLeft`, and spends no read. `chunked` tells which endpoint
serves the note: `/stream`, or `/raw` and the JSON endpoint. Asking the wrong
one answers `400` and spends no read, and so does asking for a format 1 note.

The server spends a read when it serves the ciphertext, once it has loaded
the note from storage (for a chunked note, the head). The client hasn't
decrypted anything yet, so a wrong password spends a read. Ask for the
password before reading a note whose `hasPassword` is true.

These reads answer `405` to `HEAD`, which would otherwise spend a read and
deliver nothing. Deletion, the `404` of a note that is gone, and the rule
against retrying a read are the same as in format 1.

### Limits of format 0

- **No format number.** Neither the ciphertext nor the link names the
  format: the read endpoint does. Nothing can change without breaking the
  links already shared.
- **Fixed Argon2id parameters.** They aren't stored with the note, so they
  can't be raised for new notes without breaking old ones.
- **No normalization.** A password typed in another Unicode form (NFD, as
  some systems produce, rather than NFC) derives a different key.
- **No proof of reading.** The server serves the ciphertext to anyone who
  knows the id, without checking the key. A wrong password spends a read,
  and anyone holding the link can try passwords offline, without limit.
- **Unauthenticated metadata.** `fileCount`, `maxReads` and the expiry aren't
  bound to the ciphertext.
- **Exact sizes.** Nothing pads the plaintext.
- **No key separation.** The base key, or the key derived from it, is the
  encryption key, so no other key can safely be derived from it.
- **Two kinds of note, three read endpoints**, and two layouts in the server
  layer.
