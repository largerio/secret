---
"@largerio/secret-sdk": minor
---

Format 1, written by default.

- `createNote` writes [format 1](https://github.com/largerio/secret/blob/main/PROTOCOL.md#format-1) unless `format: 0` is passed. Its links name the format (`#1.<key>`). The note is padded to a size class (Padmé, 4 KiB at least), so the instance learns its size class instead of its length. Its settings travel in an envelope the ciphertext authenticates, with the Argon2id parameters of a password note, and the password is normalized to NFC.
- `readNote` takes either format, from the link. A format 1 note is served only once the reader proves it holds the link, and the password of a password note: a wrong password spends no read, and the fifth deletes the note. `checkNote` reports the note's `envelope` and its `passwordAttemptsLeft`. A wrong link or password refused by the instance is a `SecretDecryptionError`, like a key that fails to decrypt.
- An instance older than 1.6.0 refuses format 1 with a `400`: pass `format: 0` to write to one. An SDK older than 1.3.0 cannot read a format 1 note (the instance refuses its read with a `400`, without spending one): update the readers before the writers.

Format 0 notes read and write as before.
