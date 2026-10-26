---
"@largerio/secret-sdk": minor
---

`checkNote` reports `readCount`: the reads a note has already spent, wrong passwords included, so `maxReads - readCount` is what is left before opening it. It is always `0` on a note without a read limit. The field is optional on `ExistingNoteInfo`, since an instance running an older API does not send it, and `checkNote` still accepts that response. A `readCount` that is present but not a non-negative integer is rejected as a malformed response, like any other field.
