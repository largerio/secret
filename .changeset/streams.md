---
"@largerio/secret-sdk": minor
---

Large notes no longer need to fit in memory.

- A file's `data` may be a `Blob`: a browser's `File` as it was picked, or `fs.openAsBlob()` in Node. The SDK reads it a slice at a time as it encrypts it.
- A note sent in an upload session has its session opened first, then each chunk encrypted as it goes up: only the chunk being sent is held, and a refused session (too large, a full instance) costs no encryption. Format 0 notes are still encrypted whole.
- `readNoteInto(id, keyFragment, { openFile })` writes each file to a `WritableStream` you open for it, as the download reaches it, and returns the text and the list of files. Each stream is closed once the whole note is read and checked, and aborted otherwise, so nothing of a note cut short or tampered with is kept. Format 0 notes are read whole, then written out.
- Reads take the note's chunks off the response as they arrive, rather than once the whole response is in.
