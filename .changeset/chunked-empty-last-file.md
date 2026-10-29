---
"@largerio/secret-sdk": patch
---

Two fixes to chunked uploads.

- A chunked note whose last file was empty, after a file with data, could not be read: no chunk carried the FINAL tag the reader requires since 1.1.2, so `readNote` failed with `SecretDecryptionError` after spending the read. The stream now ends on the last chunk of the last file with data.
- A note without files no longer switches to a chunked upload when its text exceeds `chunkSize`. All its text went in the first chunk, which an instance refuses beyond its chunk size (413); it is now sent single-shot, which takes any text `MAX_TEXT_SIZE` allows. `chunked: true` still forces a chunked upload.
