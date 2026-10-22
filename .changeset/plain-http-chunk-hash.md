---
"@largerio/secret-sdk": patch
---

Chunked uploads no longer depend on `crypto.subtle`. Browsers only expose it in a secure context, so on a page served over plain HTTP from a non-localhost address (an instance on a LAN, `http://<ip>:3000`) every upload above the chunk size failed with a `TypeError`. Chunk hashes now come from libsodium, which the SDK already loads.
