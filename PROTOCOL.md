# Secret protocol

This document specifies how a Secret client encrypts a note, what it sends to
an instance, and how it reads one back: enough to write a compatible client,
in any language, without reading the SDK.

It describes [format 1](#format-1), the format the web app, the SDK and the
command line write. [Format 0](#format-0-legacy), the format before it, is
described at the end: instances still read and accept it, so that links
already shared keep working. Format numbers are unrelated to the version of
the app or the SDK.

The reference implementation is [`packages/crypto`](packages/crypto/src) and
[`packages/sdk-js`](packages/sdk-js/src). The [test vectors](#test-vectors)
pin every step down to the byte. The HTTP API is also described by the
instance itself, at `/api/v1/openapi.json`.

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

A note is encrypted in the client under a random key, uploaded, and shared as
a link that carries the key in its fragment. Browsers never send the fragment
to the server, so the instance stores and serves ciphertext it cannot read.

- The note is one secretstream, whose plaintext, the [body](#the-body), is
  padded to a size class: the server learns the class, not the size of the
  text or of any file.
- The settings the writer chooses travel in an [envelope](#the-envelope),
  which the ciphertext authenticates.
- A note goes up [in one request](#in-one-request), or message by message in
  an [upload session](#in-an-upload-session) when it is large.
- A reader [proves](#proof-of-reading) that it holds the link, and the
  password of a password note, before the server serves anything: a wrong
  password spends no read, and whoever knows only the note's id can neither
  read nor burn it.

## Format 1

Instances accept format 1 from 1.6.0. An older one refuses it with `400`: a
client that must write to one writes [format 0](#format-0-legacy).

### Keys

The **link key** `K` is 32 random bytes
(`crypto_aead_xchacha20poly1305_ietf_keygen`). The [link](#the-link) carries
it.

With a password, the writer draws a 16-byte salt, picks the Argon2id
parameters, and stretches the password, followed by the link key:

```
P = Argon2id(password = UTF-8(NFC(password)) || K, salt, t, m, p = 1, version 0x13, 32 bytes)
```

`NFC` is Unicode Normalization Form C, and `UTF-8` encodes as WHATWG does: a
lone surrogate becomes U+FFFD. An empty password is no password. With `K` in
its input, Argon2id cannot be run on a dictionary before the link is known,
even by whoever holds the salt.

By default a writer uses t = 3 iterations and m = 262,144 KiB (256 MiB,
libsodium's moderate setting), and records them in the envelope. `m` is in
KiB: libsodium's `memlimit` is m × 1024 bytes. A reader runs the parameters
the envelope gives, but MUST refuse t outside 1 to 6, or m outside 65,536 to
524,288 KiB (64 to 512 MiB), before running Argon2id. It runs them before
anything can tell the envelope was altered, so these bounds are what a
server, as much as a writer, can make a reader spend. The lower bounds are a
floor too: a server that serves an altered envelope, with a new salt and the
lightest parameters, gets a password proof that costs no less than them to
attack offline, and it would need `K` to.

Then, with HKDF-SHA256 (RFC 5869):

```
IKM = K                      without a password
IKM = K || P                 with one
PRK = HKDF-Extract(salt = none, IKM)
encryption key = HKDF-Expand(PRK, info = "secret/1 enc", 32)
```

`salt = none` is HKDF's default, 32 zero bytes. `info` is ASCII. The same
secrets give the [proofs](#proof-of-reading) a reader sends:

```
link proof     = HKDF-Expand(HKDF-Extract(salt = none, K), info = "secret/1 link", 32)
password proof = HKDF-Expand(PRK, info = "secret/1 read", 32)      with a password only
link verifier     = SHA-256(link proof)
password verifier = SHA-256(password proof)
```

Without a password, the link proof's PRK is the PRK above. Proofs and
verifiers are 32 bytes. The `info` strings form one namespace over both PRKs,
which are one without a password: other strings are reserved for what format
1 will derive from them.

The password is never sent, and neither is `K`: a reader needs both the link
and the password.

### The link

```
<origin>/note/<id>#1.<key>
```

- `id`: the note's id, assigned by the server. 12 characters from
  `A-Z a-z 0-9 _ -`.
- `1.`: the format.
- `key`: `K` in base64url without padding, 43 characters. They hold 258 bits
  for 256, so the last character's two low bits are zero. A reader MUST
  reject a key encoded any other way, as libsodium does.

A [format 0](#format-0-link) key never holds a `.`, so a reader tells the
formats apart by the `1.` prefix, and MUST refuse a malformed format 1
fragment before reading the note. A fragment that starts with another number
and a dot names a format the reader does not know: it MUST refuse it before
reading the note. A format number is written in decimal without a leading
zero: `01.` names no format, and is refused as well.

The web app also gives the writer a management link,
`<origin>/note/<id>/manage#<deleteToken>`, which carries the
[delete token](#deletion) in its fragment.

### The payload

What a note holds is a MessagePack map:

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

The file bytes are not in the map: they follow it in the [body](#the-body).

The writer leaves out a key rather than writing `nil`, and leaves out `files`
for a note without files. It writes every key of a file, and writes the keys
in the order of these tables: `text`, `contentMode`, `files`, then `name`,
`type`, `size`. A reader does not depend on that order, but the
[test vectors](#test-vectors) match byte for byte only in it.
[Reading strictly](#reading-strictly) says what a reader refuses.

### The envelope

The envelope holds the settings a writer declares, and what a reader needs to
derive the key and open the ciphertext. The server reads the note's settings
from it, stores it, and serves it back byte for byte. It is the additional
data of every AEAD operation on the note, so a reader detects any change to
it, once it has derived the key.

The envelope is public: the server serves it to anyone who knows the note's
id, since a reader needs its salt and Argon2id parameters to derive the
proofs it reads with. It holds nothing derived from the password or from `K`,
and never will: from such a value, whoever has the link could test passwords
without reading the note. That is why the verifiers travel beside it, and are
never served.

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

An envelope is 33 bytes without a password, 57 with one. A reader MUST refuse
an envelope whose first byte is not 1, whose key derivation is unknown, whose
length is not the one its key derivation calls for, or whose Argon2id
parameters fall outside the bounds above. It need not check the settings
against the protocol's limits below, which the server does, but may. It uses
the envelope as it received it, never re-encoded.

The settings:

| Setting | Meaning |
|---------|---------|
| `fileCount` | The number of files in the payload. The server cannot check it against the ciphertext. It shows it before a note is opened. |
| `maxReads` | Reads before the note is deleted, 0 meaning until it expires. |
| `expiresIn` | Seconds until the note expires. |

Besides them and the Argon2id parameters, the envelope holds the stream
header and the salt, which are random: it tells the server nothing else. The
server refuses (`400`) an envelope a reader would refuse, or one whose
settings exceed the protocol's limits (`fileCount` 0 to 10, at least 1 for a
multipart upload, `maxReads` 0 to 1000, `expiresIn` 300 to 2,592,000), and
applies the instance's: `expiresIn` at most its `maxExpiry`, `fileCount` at
most its `maxFilesPerNote`. Envelopes travel in base64. A request that
carries an `envelope` key, whatever its value (`null` included), is a format
1 request: [format 0](#single-shot-notes)'s fields beside it are ignored.

### The body

The plaintext of a note is its **body**: the head, the file bytes, then
padding.

```
body = len(head) || head || file 1 || ... || file n || padding
```

- `len(head)` is the head's length in bytes, 4 bytes unsigned big-endian.
- The **head** is the [payload](#the-payload), as MessagePack. For a note
  with files, `files` lists every file, empty ones included.
- Each file's bytes follow in turn, `size` bytes each, in the order of
  `files`.
- The **padding** is zero bytes, as many as make the body's length the
  **size class** of the length without them,
  `L = 4 + len(head) + the sum of the files' sizes`:

```
size class(L) = 4096                     when L <= 4096
size class(L) = ceil(L / 2^z) * 2^z      otherwise, where E = floor(log2(L)),
                                         S = floor(log2(E)) + 1, z = E - S
```

This is Padmé (Nikitin et al., *Reducing Metadata Leakage from Encrypted
Files and Communication with PURBs*, PETS 2019) with a floor: every body up
to 4,096 bytes, a password as much as a private key, has the same length, and
a longer one is at most 6.25% longer than its content, 3.125% from 65,536
bytes on. `E` is the bit length of `L` less one: compute in integers, as a
floating-point `log2` may round up just below a power of two. Content of
4,097 bytes takes a body of 4,352, content of 1,000,000 bytes one of
1,015,808. A length is a size class when it is its own size class.

### Messages

The writer opens a secretstream under the encryption key, builds the
envelope with its header, and cuts the body into messages of `C` bytes, a
length it picks: every message but the last holds `C` bytes, and the last
holds the rest, 1 to `C` bytes. A body sent as one message is cut with `C`
equal to its length. Every message is pushed with the envelope as additional
data, and its ciphertext is 17 bytes longer than its plaintext. The last
message, and only the last, carries `TAG_FINAL` (3); every other one carries
`TAG_MESSAGE` (0).

The cut ignores the body's content: a message can hold the end of the head
and the start of a file, or bytes of two files.

### Writing a note

A note goes up as one message, in one request, or message by message, in an
upload session. A writer that sends a note in a session SHOULD take the
instance's `chunkSize` as `C`, so that its messages look like every other
writer's there. The reference SDK sends a note without files as one message,
and a note with files as one message when its body fits in `C`, in a session
otherwise.

#### In one request

The note is sent with the envelope, the [verifiers](#keys), and its one
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

A note with files can also go as `multipart/form-data` to
`POST /api/v1/notes/upload`, which spares the base64 overhead: `metadata` is
a JSON string with the same object without `encryptedData`, and `data` the
message, as a file part.

`passwordVerifier` is sent for a password note only: the server refuses
(`400`) a write without a link verifier, without a password verifier for a
password note, or with one for a note without a password, `null` included: a
key counts as sent whatever its value. A verifier is 32 bytes.

Both answer `201` with `{"id", "expiresAt", "deleteToken"}`. A note without
files is limited to 524,288 bytes of ciphertext, and any request to the
instance's `maxFileSize × maxFilesPerNote` plus 1 MiB. The server also
refuses (`413`) a message too long for a read to
[frame](#proof-of-reading). It keeps the expiry to the second: every
`expiresAt`, and `X-Expires-At`, has its milliseconds at zero (`.000Z`).

#### In an upload session

The chunk size is the instance's `chunkSize` (4,194,304 bytes by default): a
message holds at most `chunkSize` bytes of the body, and the server refuses
(`413`) a message whose ciphertext is longer than `chunkSize` plus 17 bytes.

1. Open the session:

   ```
   POST /api/v1/notes/upload/init
   Content-Type: application/json

   {"envelope": "<base64 envelope>", "linkVerifier": "<base64>", "chunkCount": 3}
   ```

   with `passwordVerifier` too for a password note. `chunkCount` is the
   number of messages. The answer is `201` with `{"uploadId", "expiresAt"}`,
   where `expiresAt` is the session's: it lasts an hour.

   The instance's `maxChunkedFileSize` bounds the files, not the padding: a
   session may announce the messages of the padded body that many bytes of
   files make, with 524,288 bytes of room for the head
   ([Instance limits](#instance-limits)). It refuses more (`400`).

2. Send every message, `index` counting from 0:

   ```
   PUT /api/v1/notes/upload/{uploadId}/chunks/{index}
   Content-Type: application/octet-stream
   X-Chunk-Hash: <lower-case hex SHA-256 of the body>
   ```

   The body is the message's ciphertext. `X-Chunk-Hash` is required: a
   missing or upper-case hash, or one that does not match the body, answers
   `400`. The answer is `200` with `{"received": true}`. Sending a message
   again replaces it, once the first sending has answered: while a message
   is being written, sending it again answers `409`.

3. Close the session, with an empty body:

   ```
   POST /api/v1/notes/upload/{uploadId}/complete
   ```

   The answer is `201` with `{"id", "expiresAt", "deleteToken"}`, the expiry
   counting from now, `400` while a message is missing, or `409` while a
   message is still being written: complete once every sending has
   answered. The session is then gone: completing it again, or sending it a
   message, answers `404`.

Everything `/init` takes is known before the first message is encrypted: the
reference SDK opens the session first, so that a refused session costs no
encryption, then encrypts each message as it goes up.

The server checks the lengths it sees against the body's rules: it refuses
(`400`) a note whose body, the messages' length less 17 bytes each, is not a
size class and, in a session, one whose messages before the last differ in
length, or whose last message is longer than the first or holds no byte of
the body. A session is checked at `/complete`: refused, it stays open, as one
with a message missing, until it is completed or expires.

### Proof of reading

A note is read in two steps, and the server serves nothing before the reader
has proved what it holds.

1. The reader asks for the note's metadata, which spends no read:

   ```
   GET /api/v1/notes/{id}/exists
   ```

   It answers `200` whether the note exists or not: `{"exists": false}` for a
   note that does not exist or has expired, and otherwise:

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

   `envelope` is the note's envelope. `passwordAttemptsLeft`, for a password
   note only, goes from 5 down to 1. `readCount` stays 0 for a note with
   unlimited reads. The other fields come from the envelope
   ([Reading strictly](#reading-strictly)).

2. The reader checks the envelope, derives the keys and the proofs from it,
   and sends the proofs:

   ```
   POST /api/v1/notes/{id}/reads
   Content-Type: application/json

   {"linkProof": "<base64>", "passwordProof": "<base64>"}
   ```

`passwordProof` is sent for a password note only; the server ignores a
well-formed one on a note without a password. A request whose proofs are not
32 bytes in base64 answers `400` and counts nothing. The server checks,
before it spends anything:

- that the note exists: a note that does not answers `404`, as every read;
- that the note is a format 1 note: a format 0 note answers `400`;
- the link proof, against the note's link verifier: a wrong one answers `403`
  and counts nothing, since whoever does not hold `K` cannot guess it;
- for a password note, that a password proof was sent (`400` otherwise), and
  that it matches the password verifier. A wrong one answers `403` and counts
  one failed attempt.

Failed attempts are counted on the note over its whole life: a read that
succeeds does not reset them, and wrong passwords sent at once each count.
The **fifth** deletes the note, as a burn would, and answers `403` like the
others. Both refusals answer `403`, told apart by their [code](#errors),
`wrong_link_proof` or `wrong_password`; a `403` without a code is not a
refused proof. The answer does not say whether the note is gone: `/exists`
does, with `passwordAttemptsLeft`, or `{"exists": false}` once the note is
deleted.

Once the proofs check out, the server serves the note, and spends a read
once it has loaded the first message. It answers `200`,
`Content-Type: application/octet-stream`. The body is every message's
ciphertext in order, each preceded by its length as a 4-byte unsigned
big-endian integer, whether the note went up in one request or in a session.
A message is therefore at most 4,294,967,295 bytes: an instance's
`chunkSize` stays 17 bytes below that. The headers carry the rest:

| Header | Value |
|--------|-------|
| `X-Has-Password` | `true` or `false`. |
| `X-File-Count` | `fileCount`. |
| `X-Created-At`, `X-Expires-At` | ISO 8601 timestamps. |
| `X-Chunk-Count` | The number of messages. |

For a note sent in one request, `Content-Length` gives the body's length, 4
bytes and the message; a session's is not known before it is read.

When the reads spent reach `maxReads`, the server deletes the note. A note
that never existed, has expired, was burned or was deleted answers `404`, the
same way. Every note endpoint answers `400` to an id that is not 12
characters of the alphabet above.

A client MUST NOT retry a read on its own: the retry could spend a second
read, or meet a `404` in place of the real error.

The reader opens the messages with the envelope it derived the proofs from.
The [format 0 reads](#format-0-reads) answer `400` to a format 1 note without
spending a read, so a client that knows only format 0 never spends one on
it. The link a reader holds decides the format it reads: a note behind the
link of the other format is refused, not opened.

### Reading strictly

In `/exists`, the settings of a format 1 note come from its envelope:
`hasPassword`, `fileCount`, `maxReads`, and `expiresAt` from its `expiresIn`.
`chunked` is always false: a format 1 note has one read, however it went up,
and the field would tell anyone who knows the id whether it went up in a
session, which hints at its size. A reader goes by the envelope, which the
ciphertext authenticates, not by these fields.

A format 1 reader MUST refuse, before it sends a proof:

- an `/exists` answer without an envelope, or with one a reader would refuse;
- a password note read without a password; a password given for a note
  without one is ignored.

Once it has read the note, it MUST refuse:

- a note of no message, a message before the last whose tag is not
  `TAG_MESSAGE`, and a last one whose tag is not `TAG_FINAL`;
- a body shorter than 4 bytes, or than 4 bytes and the head's length;
- a head that is not one MessagePack map (an extension type, a timestamp
  included, is not a map) filling its length exactly, whose `text` is not a
  string, whose `contentMode` is not one of the three values, or whose
  `files` is not an array of at most 10 entries;
- a file that is not a map, or whose `name` or `type` is not a string, or
  whose `size` is not a non-negative integer, a missing key included;
- a head with another number of files than the envelope's `fileCount`;
- file sizes whose sum exceeds the bytes after the head;
- a body whose length is not the size class of `L`, or whose padding holds a
  byte other than zero.

A key present with the value `nil` is not absent: `text: nil` is refused. A
`files` that is empty is a note without files. A reader ignores keys it does
not know. It need not check the length of each message: the server does, and
the tags and the body's length are enough. It MUST NOT show any part of the
payload before it has opened the last message and checked the body: only
then does it know the note is whole. A reader that writes the files out as
the messages open, so as not to hold a large note in memory, keeps what it
writes where nothing shows it, and discards it unless the body checks out:
the reference SDK closes the stream it writes each file to once the body
checks out, and aborts it otherwise.

A writer writes each key of a map once, as a `str`, strings in valid UTF-8
(a lone surrogate written as U+FFFD), and `size` as an `int`, each value in
the shortest form MessagePack has for it, as common libraries do: the
vectors' heads match byte for byte only then. A reader MUST refuse a map
that repeats a key, or keep the last of its values, as the reference reader
does. An integer is a MessagePack `int`; a reader may also take a float with
an integer value for one, as the reference reader does. The reference reader
also reads an integer key as a string and decodes invalid UTF-8 without
refusing it, which another reader may refuse, and it refuses a `__proto__`
key and a key that is neither a string nor a number, which no writer
writes: another reader may refuse them too.

## Deletion

```
DELETE /api/v1/notes/{id}
X-Delete-Token: <deleteToken>
```

The delete token is the 32-character token returned at creation. The request
also needs [write authentication](#authentication). The answer is
`{"deleted": true}`, `403` for a wrong token, or `404`.

## Authentication

Reads need no authentication: a format 1 read [proves](#proof-of-reading)
that it holds the link instead. Creating and deleting a note need one of:

- `Authorization: Bearer <API key>`, with a key the operator configured;
- `X-Cap-Token: <token>`, a single-use token the instance gives for a
  [proof of work](#proof-of-work), as the web app and the command line get
  one.

Message uploads and `/complete` need neither: the upload id stands for the
authentication given to `/init`. A refusal answers `401` (`unauthorized`),
whatever failed.

### Proof of work

The proof of work is [Cap](https://capjs.js.org)'s, as the instance serves it
under `/api/cap/` with `@cap.js/server` 4. It is Cap's format, not this
protocol's: it has no version number, its paths are not versioned, and a
release of Cap may change it. A contract test
([`proofOfWork.test.ts`](apps/api/src/__tests__/proofOfWork.test.ts)) runs
the command line's solver against the instance and fails if they part.

A client asks for a challenge, solves it, and redeems the solutions for a
token:

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

where `i` is written in decimal and `‖` joins strings. `prng(seed, n)` is
Cap's generator, on 32-bit unsigned integers, every operation modulo 2^32:

1. `h` is the FNV-1a hash of the seed's ASCII bytes: `h = 2166136261`
   (`0x811c9dc5`), then for each byte `b`, `h = (h XOR b) × 16777619`.
2. Until the output holds `n` characters: `h ^= h << 13`, `h ^= h >> 17`,
   `h ^= h << 5` (xorshift32, `>>` a logical shift), then append `h` as 8
   lowercase hex digits, zero-padded.
3. The output is cut to its first `n` characters.

A solution to challenge `i` is an integer `n_i ≥ 0` such that the SHA-256 of
the ASCII bytes of `salt_i ‖ n_i`, with `n_i` in decimal without leading
zeros, written in lowercase hex, starts with `target_i`. A try succeeds with
probability 16^−d: a challenge takes 65,536 tries on average at the default,
its 50 challenges 3.3 million, about a second on one core. Any solution is
accepted; the web app and the command line count up from 0.

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

`token` is the write token: 16 hex characters, `:`, then 30. It expires 20
minutes after it was given, at `expires`. A wrong solution, an unknown or
expired challenge, or a body of another shape answers `400` with Cap's
`{"success": false, "message": "<why>"}`, not a problem details object. A
well-formed `/redeem` spends the challenge, right or wrong: a challenge is
redeemed once.

The write token goes in `X-Cap-Token`, for one write. The instance deletes it
once it has checked it, before it looks at the rest of the request: a write
refused after that, by its validation say, has spent it. A second use answers
`401`. Challenges and tokens live in the instance's memory: a restart forgets
them.

`/api/cap/challenge` and `/api/cap/redeem` share one rate limit, counted per
address apart from the notes' requests: 60 a minute, times the instance's
`RATE_LIMIT_MULTIPLIER`. A write by proof of work takes two of them. Past it,
they answer `429` (`rate_limited`) as problem details, with `Retry-After`.

The instance chooses `c` and `d`, and so how long a client works. A client
SHOULD bound what it accepts: the command line refuses a challenge with `c`
above 1,024, `s` above 64, `d` above 6, or `c × 16^d` above 2^27
(134,217,728), and gives up a challenge after `64 × 16^d` tries.

For example, with the token above and the default `c`, `s` and `d`, the
seed of `salt_1` is `0123456789abcdef0123456789abcdef0123456789abcdef011`.
Its FNV-1a hash is `0x76137c29`, and the first xorshift32 output from it
`0x2b5c4ca2`. The first two challenges, with their smallest solutions:

| `i` | `salt_i` | `target_i` | `n_i` | SHA-256 of `salt_i ‖ n_i` |
|-----|----------|------------|-------|---------------------------|
| 1 | `2b5c4ca2fbc3e5066b0fb0573da6c475` | `b948` | 20759 | `b948954ef5a255fac7e357ec97ba8b9eca5ed9879b2e33d441fad0030dc00674` |
| 2 | `a252484e802441830a9094a918b2adcb` | `105e` | 12490 | `105eadbd77d3dec19ca1ea80425e8fe2ef82e8e141e3847c309cd6d096060799` |

## Instance limits

```
GET /api/v1/config
```

answers the limits a client should respect before uploading:

| Field | Meaning |
|-------|---------|
| `maxFileSize` | Sizes the limit on a note sent in one request: `maxFileSize × maxFilesPerNote` plus 1 MiB. |
| `maxFilesPerNote` | The largest `fileCount`. |
| `maxExpiry` | The largest `expiresIn`, in seconds. |
| `chunkSize` | The largest message plaintext in an upload session, in bytes: a positive integer, no larger than `maxChunkedFileSize` nor than 4,294,967,278 (a message's length, its 17-byte tag included, fits in 4 bytes). |
| `maxChunkedFileSize` | The most file bytes a note sent in a session carries. It bounds the files, not what the format adds to them: a session may announce the messages of the padded body that many bytes of files make, with 524,288 bytes of room for the head (a format 0 session: a head message, and a message started per file). |

## Errors

An error answers a [problem details](https://www.rfc-editor.org/rfc/rfc9457)
object, as `application/problem+json`:

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

`code` names the error and does not change from one release to the next:
tell errors apart by it. `detail` is meant for a developer and may change;
`error` repeats it for clients written before codes. A `500` also carries
`errorId`, which the instance logs with the error.

An answer without a `code` comes from something in front of the instance, a
reverse proxy, a firewall or a CDN, not from the instance: a `403` without one
is not a wrong proof. A client that meets a code it does not know goes by the
status.

| Code | Status | Meaning |
|------|--------|---------|
| `invalid_request` | 400 | A request that does not match its endpoint, a note id that is not 12 characters of the alphabet above included |
| `note_format_mismatch` | 400 | A read of another format than the note's, which spends nothing |
| `note_is_chunked` | 400 | `/raw` or the JSON endpoint asked for a chunked note |
| `note_is_single_shot` | 400 | `/stream` asked for a single-shot note |
| `password_proof_missing` | 400 | A password note's read without its password proof |
| `note_not_padded` | 400 | A format 1 note whose message lengths do not fit a [padded body](#the-body) |
| `expiry_above_limit` | 400 | `expiresIn` above the instance's `maxExpiry` |
| `too_many_files` | 400 | `fileCount` above the instance's `maxFilesPerNote` |
| `too_many_chunks` | 400 | A `chunkCount` above what the instance's `maxChunkedFileSize` allows |
| `upload_incomplete` | 400 | `/complete` while a message is missing |
| `chunk_out_of_range` | 400 | A message index outside the session's `chunkCount` |
| `chunk_empty` | 400 | A message without a byte |
| `chunk_hash_mismatch` | 400 | A message whose `X-Chunk-Hash` is missing, upper-case, or not its hash |
| `unauthorized` | 401 | Write authentication missing or refused |
| `wrong_link_proof` | 403 | A format 1 read whose link proof is wrong, which counts nothing |
| `wrong_password` | 403 | A format 1 read whose password proof is wrong, which counts a failed attempt |
| `wrong_delete_token` | 403 | A deletion with the wrong token |
| `not_found` | 404 | No such endpoint |
| `note_not_found` | 404 | The note does not exist, has expired, or was burned or deleted |
| `upload_not_found` | 404 | The upload session does not exist, has expired, or was completed |
| `method_not_allowed` | 405 | `HEAD` on a read |
| `upload_already_completed` | 409 | A message sent while its session was being completed |
| `chunk_in_flight` | 409 | A message sent again, or `/complete`, while a message of the session is still being written |
| `payload_too_large` | 413 | A request body above the instance's limits |
| `note_too_large` | 413 | A note without files above 524,288 bytes of ciphertext, or a format 1 message too long for a read to frame |
| `chunk_too_large` | 413 | A message above the instance's `chunkSize` |
| `unsupported_media_type` | 415 | A body that is not JSON, or not multipart for `/notes/upload` |
| `rate_limited` | 429 | Too many requests from this address |
| `internal_error` | 500 | A server error |
| `note_corrupted` | 500 | A note the server cannot open |
| `upload_corrupted` | 500 | An upload session the server cannot read |
| `storage_quota_exceeded` | 507 | The instance's storage quota is full |

A `429` carries `Retry-After`, in seconds. Requests are counted per address
and per kind (creates, reads, `/exists`, messages, the
[proof of work](#proof-of-work)), writes with an API key included. A refused
request spends nothing: a message refused in the middle of an upload session
can be sent again once the wait is over.

## What the server learns

The server never holds a key or a password, so it never sees a note's text,
file names, MIME types or file bytes. It does learn:

- the metadata it is given: whether the note has a password, `fileCount`,
  `maxReads`, the expiry, the salt and the Argon2id parameters, and when the
  note was created and read;
- the verifiers, the proofs a reader sends, and how many wrong passwords were
  tried. A proof is an HKDF output apart from the key, a verifier its
  SHA-256: without `K` they tell nothing of the key or the password, but
  whoever holds a note's proofs can have its ciphertext served, and whoever
  also holds `K` can test passwords against a password proof or verifier
  offline, at the cost of Argon2id, as against the ciphertext. Treat them as
  secrets: a proxy that logs request bodies must not keep them;
- the [size class](#the-body) of the body, and the length of its messages,
  which its writer picked: every note up to 4,096 bytes looks the same, and a
  larger one is known to within 6.25%. A format 0 note gives away more: in
  one piece, the length of its text and files together, to within a few
  bytes; chunked, the size of its head and of each file.

## Server layer

This section is for operators: a client never sees this layer.

The instance encrypts what it stores again, with AES-256-GCM under its
`SERVER_ENCRYPTION_KEY`: a random 12-byte IV, the 16-byte tag after the
ciphertext, and the ASCII bytes of the note id as additional data, so that a
blob moved to another note fails to decrypt.

- A note sent in one request, or a format 0 single-shot note, keeps its IV in
  the database (`notes.server_nonce`, in base64), and its ciphertext with the
  tag in the database (`notes.encrypted_data`) for a note without files, or
  in the storage for a note with files. A format 1 note's ciphertext is its
  one message.
- A note sent in a session, or a format 0 chunked note, stores every message
  as its own object: IV, ciphertext, tag.

A format 1 note's verifiers are not stored as they came, but sealed:

```
verifier key = HKDF-SHA256(SERVER_ENCRYPTION_KEY, salt = none, info = "secret/server verifier", 32)
sealed       = HMAC-SHA256(verifier key, role || 0x00 || note id || SHA-256(envelope) || verifier)
```

`role` is the ASCII `link` or `password`, the note id its 12 ASCII
characters. A copy of the database without the key thus gives nothing to test
passwords against, even to whoever holds the link; and whoever can write to
the database without the key cannot swap one verifier for the other, or
rewrite the envelope, and still have the note served.

The server counts a password attempt before it compares the proof, and gives
it back once the proof matches: a wrong and a right password then cost the
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
  present. A format 1 note carries its header inside its envelope, at
  offset 9.
- The `messageSize` of a `format1.notes` vector is its `C`. One of them cuts
  its body every 1,001 bytes, where libsodium's MAC padding (the text's
  length modulo 16, not what RFC 8439 pads) shows, and another fills its
  size class, without padding.
- A `format1.invalid.notes` vector breaks the one rule its `rule` names, in
  the order of [Reading strictly](#reading-strictly): `decryption` (its
  messages do not open), `stream` (their tags), `body` (the head's length),
  `head`, `file`, `file-count`, `file-sizes` or `padding` (the size class
  and the zeros).
- A writer draws its stream header at random, but the format 1 vectors fix
  it: libsodium's `crypto_secretstream_xchacha20poly1305_init_pull` makes,
  from a header, the state of a writer that drew it, which pushes as well as
  it pulls.
- In the format 0 `secretstream` vectors, `headerMsgpack` is the head's
  plaintext and `header` the secretstream header. Their `chunkSize` only says
  where the file bytes are cut: their heads are longer than it, which an
  instance with that chunk size would refuse.

The vectors are frozen. The repository checks them against libsodium and
against a second implementation that shares no code with it, OpenSSL through
`node:crypto` (`vectors-openssl.test.ts`). A new client should pass all of
them.

## Format 0 (legacy)

Format 0 is the format before format 1. Instances read and accept it
throughout the app's 1.x releases, so that links already shared, and clients
that only speak format 0, keep working. The SDK writes it when asked
(`format: 0`), and so does the command line (`--format 0`), for an instance
older than 1.6.0. A new client need not write it; a reader that opens links
it did not write may meet it.

Format 0 carries no format number: neither the ciphertext nor the link says
which format it is, the read endpoint does. Its [limits](#limits-of-format-0)
are what format 1 lifts.

A format 0 note is one of two kinds, which share the keys and the link:

- **Single-shot**: the whole note is one AEAD ciphertext. For text and small
  files.
- **Chunked**: the note is a secretstream, uploaded and served message by
  message. For large files.

A writer may use either kind within the instance's limits. The SDK switches
to chunked when its estimate of the payload's size exceeds the chunk size.

### Format 0 keys

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

### Format 0 link

```
<origin>/note/<id>#<key>
```

`id` is as in [format 1](#the-link). `key` is the base key in base64url
without padding, 43 characters, encoded as format 1's key is. A reader MUST
reject a key encoded any other way before reading the note: a format 0 read
spends a read whatever the key, so a key cut short in transit would otherwise
burn the note unread. The web app also refuses any other shape
(`^[A-Za-z0-9_-]{43}$`).

### Format 0 payload

The payload is [format 1's](#the-payload). In a single-shot note, it also
carries each file's bytes: a file has a fourth key, `data` (bin), written
after `size`, and `size` is the length of `data`.

A reader SHOULD reject a payload that is not a map, whose keys have the wrong
type, or whose `contentMode` is not one of the three values. The reference
reader checks less: it rejects a `text` that is not a string, an unknown
`contentMode`, a `files` that is not an array, and a file whose `name` or
`type` is not a string or whose `size`, when present, is not a number. It does
not check that the payload is a map, the type of `data`, the number of files,
or that `size` matches the data. It ignores keys it does not know.

### Single-shot notes

To encrypt:

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

A note with files can also go as `multipart/form-data` to
`POST /api/v1/notes/upload`, as the SDK does: `metadata`, a JSON string with
the same fields except `encryptedData`, and `data`, the ciphertext bytes as a
file part.

| Field | Value |
|-------|-------|
| `hasPassword` | Whether the key was derived from a password. When true, `salt` is required. |
| `salt` | The 16-byte salt, in base64. The server keeps it whatever `hasPassword` says. |
| `expiresIn` | Seconds until the note expires: 300 to 2,592,000, and at most the instance's `maxExpiry`. |
| `maxReads` | Reads before the note is deleted: 0 to 1000, 0 meaning until it expires. Default 1. |
| `fileCount` | The number of files in the payload: 0 to 10, at least 1 for a multipart upload, and at most the instance's `maxFilesPerNote`. The server cannot check it against the ciphertext. It shows it before a note is opened. |
| `clientNonce` | The nonce, in base64, at most 48 characters. |

The server checks neither the salt's length nor the nonce's: with a wrong one,
the note is created and nobody can read it. The answer, and the limits on the
request's size, are those of a format 1 note sent
[in one request](#in-one-request).

To read it:

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

### Chunked notes

The writer opens a secretstream under the encryption key. Its 24-byte header
is sent to the server. Every message is pushed with empty additional data, and
its ciphertext is 17 bytes longer than its plaintext. The messages, in order:

1. **The head**: the payload without the file bytes, as MessagePack, as
   format 1's [head](#the-body). The head is one message, so it must fit in
   the chunk size: a writer whose head does not fit sends the note
   single-shot.
2. **The file bytes**: each file in turn, cut into pieces of at most the
   instance's chunk size. A piece never holds bytes of two files, and an empty
   file has no piece.

The last message, and only the last, carries `TAG_FINAL` (3). Every other
message carries `TAG_MESSAGE` (0). A note with no file bytes is a single
message: the head, final.

A reader MUST reject the stream unless the last message carries `TAG_FINAL`
and no other message does. The reference reader takes any other tag for
`TAG_MESSAGE`. A reader MUST reject a head-only stream whose head declares a
file larger than 0 bytes. It joins the pieces, then splits them into files by
the declared sizes, in order, and MUST reject the stream when they fall
short. The reference reader ignores bytes beyond the declared sizes. It
checks the head like a payload.

The note goes up in an [upload session](#in-an-upload-session), opened with
format 0's fields:

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

`chunkCount` is the number of messages, head included. `clientNonce` is not
used by chunked notes, but required. The other fields are those of a
single-shot note. `/init` refuses (`400`) a note of more than
`maxChunkedFileSize` divided by `chunkSize` messages, rounded up, head
included. The server checks the length of neither the stream header nor the
salt. The messages and `/complete` go as in format 1.

To read it:

```
GET /api/v1/notes/{id}/stream
```

The headers are those of `/raw`, with `X-Stream-Header` (the secretstream
header, in base64) and `X-Chunk-Count` in place of `X-Client-Nonce`. The body
is every message's ciphertext in order, each preceded by its length, as a
format 1 note is [served](#proof-of-reading).

### Format 0 reads

`/exists` answers as for a format 1 note, without `envelope` or
`passwordAttemptsLeft`, and spends no read. `chunked` tells which endpoint
serves the note: `/stream`, or `/raw` and the JSON endpoint. Asking the wrong
one answers `400` and spends no read, and so does a read of a format 1 note.

The server spends a read as it serves the ciphertext, once it has loaded the
note from its storage (for a chunked note, the head). The client has not
decrypted anything yet, so a wrong password spends a read. Ask for the
password before reading a note whose `hasPassword` is true.

These reads answer `405` to `HEAD`, which would spend a read and deliver
nothing. Deletion, the `404` of a note that is gone, and the rule against
retrying a read are format 1's.

### Limits of format 0

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
