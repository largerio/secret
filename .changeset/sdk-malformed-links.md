---
"@largerio/secret-sdk": patch
---

A malformed link is refused before any request, so it no longer spends a read:

- `checkNote`, `readNote`, `readNoteInto`, `deleteNote` and `buildShareUrl` refuse with a `SecretValidationError` an id the server cannot have given (12 characters of `A-Z a-z 0-9 _ -`), and `parseShareUrl` a link that holds one. Such an id took the request to another endpoint: checking `…/note/aBcDeFgHiJkL%3F#…` sent `GET /notes/{id}`, the format 0 read that spends the note, instead of asking for its metadata. Ids are also encoded in every request's path.
- `readNote` and `readNoteInto` refuse with a `SecretValidationError` a format 0 key that is not 43 base64url characters decoding to 32 bytes, as they already did for format 1. A key cut short, or the delete token of a management link (`/note/<id>/manage#<token>`) read as a note's link, was refused only once the note had been served: its read was spent, and a note read once was gone.
