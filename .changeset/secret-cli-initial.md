---
"@largerio/secret-cli": minor
---

First release of `@largerio/secret-cli`, a command-line client for Secret installed as the `secret` binary.

It wraps `@largerio/secret-sdk` — every encryption and HTTP operation goes through `SecretClient`; the CLI only parses arguments and moves bytes between the terminal, the filesystem and the SDK — and adds no dependency beyond the SDK (argument parsing uses `node:util`'s `parseArgs`).

- `secret send [files...]` encrypts and uploads text (piped on stdin or given with `--text`) and/or files, with `--password`, `--burn`, `--reads` and `--expires`. The share URL (with its `#key` fragment) is printed on stdout, the delete token and expiry on stderr; `--json` prints everything as one object.
- `secret get <url>` checks the note first, then downloads and decrypts it: text on stdout, files saved under their sanitised name into `--out` (an existing file gets a numbered name unless `--force` is passed). A password-protected note is refused before any read is consumed when `--password` is missing.
- `secret check <url>` shows the metadata without consuming a read; `secret delete <url> <deleteToken>` revokes a note.
- The instance and API key come from `--server` / `--api-key` or `SECRET_SERVER_URL` / `SECRET_API_KEY`; for reads, the instance is taken from the note URL itself. Writes require an API key (the Proof-of-Work path is browser-only).
