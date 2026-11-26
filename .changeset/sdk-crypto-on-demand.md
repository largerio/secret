---
"@largerio/secret-sdk": minor
---

The crypto loads on demand. `new SecretClient(config)` is public: it returns a client at once, and loads the crypto (libsodium and MessagePack, in a chunk of their own) on the first `createNote`, `readNote` or `readNoteInto`. A client that only checks and deletes notes, or builds and parses links, never loads it. `SecretClient.create(config)` is unchanged: it loads and initialises the crypto first, so an environment that can't run it fails there.
