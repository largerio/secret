---
"@largerio/secret-sdk": minor
---

The protocol's limits are exported, so that a client can check what it is given before the SDK refuses it: `MAX_TEXT_SIZE`, the characters of a note's text; `MAX_FILES_PER_NOTE`; `MAX_READS`; `MIN_EXPIRY_SECONDS`, `MAX_EXPIRY_SECONDS` and `DEFAULT_EXPIRY_SECONDS`, the one `createNote` takes when none is given; `MAX_PASSWORD_ATTEMPTS`, the wrong passwords a format 1 note takes; `DEFAULT_CHUNK_SIZE`; and `NOTE_ID_LENGTH`, the characters of a note's id. An instance may set lower limits of its own, which it announces at `GET /api/v1/config`.
