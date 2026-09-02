# @largerio/secret-cli

Command-line client for [Secret](https://github.com/largerio/secret) — send, read, check and delete zero-knowledge, end-to-end encrypted notes and files from your terminal.

Everything is encrypted **on your machine** with XChaCha20-Poly1305 before anything is sent. The key travels only in the `#fragment` of the share URL, which browsers never send to the server. The CLI is a thin layer over [`@largerio/secret-sdk`](https://www.npmjs.com/package/@largerio/secret-sdk): it parses arguments and moves bytes between your terminal, your files and the SDK. No cryptography and no HTTP of its own.

```bash
npm install -g @largerio/secret-cli
# or, without installing:
npx @largerio/secret-cli --help
```

Requires Node.js 20 or later.

> **Reads are open on every instance. Writes are not.** `send` and `delete` need an API key — a value the instance operator sets in their own environment. There is no sign-up, and the Proof-of-Work alternative the web UI uses is browser-only. Point the CLI at an instance you run, or at one that issued you a key. See [Configuration](#configuration).

## Usage

```
secret send [files...]              Encrypt and upload text (stdin or --text) and/or files
secret get <url>                    Download and decrypt a note
secret check <url>                  Show a note's metadata without consuming a read
secret delete <url> <deleteToken>   Delete a note before it expires
```

### send

```bash
# Text from stdin — the share URL is the only thing on stdout
echo "the launch code is 0000" | secret send
# → https://secret.example.com/note/aBcDeFgHiJkL#K7pQ…
#   Delete token: …      (stderr)
#   Expires: 2026-…      (stderr)

# Text from a flag, readable three times, gone after two hours
secret send --text "rotate me" --reads 3 --expires 2h

# Files, with a password on top of the key
secret send report.pdf photo.png --password hunter2

# Files and a message together
echo "see attached" | secret send report.pdf

# Machine-readable
secret send --text "hi" --json
# → {"url":"…","id":"…","deleteToken":"…","expiresAt":"…"}
```

| Option | | |
|---|---|---|
| `-t, --text <text>` | Text to send instead of reading stdin | |
| `-p, --password <pw>` | Also protect the note with a password (Argon2id-derived) | |
| `-b, --burn` | Burn after the first read | default |
| `-r, --reads <n>` | Allow `n` reads before the note is deleted, `0` = unlimited | |
| `-e, --expires <dur>` | Expiry: seconds, or `30m`, `2h`, `7d` | `24h` |
| `--json` | Print `{ url, id, deleteToken, expiresAt }` as JSON on stdout | |

The URL alone goes to stdout, the delete token and expiry to stderr, so `secret send | pbcopy` copies exactly the link. Text is read from stdin whenever stdin is not a terminal; pass `--text` (or `< /dev/null`) in environments where stdin is attached but never closed.

### get

```bash
secret get "https://secret.example.com/note/aBcDeFgHiJkL#K7pQ…"
secret get "$URL" --password hunter2 --out ./downloads
```

Text is printed on stdout; files are saved into `--out` (default: the current directory) under their own name, with any directory part stripped. An existing file is never overwritten: the download gets a numbered name (`report (1).pdf`) unless `--force` is passed. The read has already been consumed by then, so failing instead would lose a burn-after-read note.

**Reading consumes a read.** On a burn-after-read note there is no second chance, so the CLI checks the note first and refuses — without touching it — when the note is password-protected and no `--password` was given.

Quote the URL: `#` starts a comment in most shells.

| Option | |
|---|---|
| `-p, --password <pw>` | Password the note was protected with |
| `-o, --out <dir>` | Directory to save files into |
| `-f, --force` | Overwrite existing files instead of saving under a numbered name |

### check

```bash
secret check "https://secret.example.com/note/aBcDeFgHiJkL"
# Status:    available
# Password:  required
# Files:     2
# Reads:     1 (burn after reading)
# Expires:   2026-09-03T00:00:00.000Z

secret check "$URL" --json
```

Does not consume a read. Exits `1` when the note is gone — expired, burned, or never existed; the instance deliberately does not say which.

### delete

```bash
secret delete "https://secret.example.com/note/aBcDeFgHiJkL" "$DELETE_TOKEN"
```

Needs an API key. The URL may be given with or without its `#key` fragment; a bare note id works too.

## Configuration

| Flag | Environment variable | |
|---|---|---|
| `-s, --server <url>` | `SECRET_SERVER_URL` | The Secret instance to talk to |
| `-k, --api-key <key>` | `SECRET_API_KEY` | API key; required by `send` and `delete` |

A flag wins over the environment. For `get`, `check` and `delete`, the instance is taken from the note URL when neither is set, so a pasted share link is enough.

`send` writes and therefore needs both. The instance operator sets the key (`API_KEY=…` in the instance's environment, 32 characters minimum); running your own takes three lines:

```bash
curl -O https://raw.githubusercontent.com/largerio/secret/main/docker-compose.yml
echo "API_KEY=$(openssl rand -base64 32)" > .env
docker compose up -d      # → http://localhost:3000
```

Then:

```bash
export SECRET_SERVER_URL=http://localhost:3000
export SECRET_API_KEY=…   # the value from .env
echo "hello" | secret send
```

See the [self-hosting guide](https://github.com/largerio/secret/blob/main/docs/self-hosting.md) for a real deployment.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | The operation failed: note not found, wrong password or key, server or network error |
| `2` | Usage error: unknown option, missing argument, nothing to send, no API key for a write |

Errors are printed on stderr, prefixed with `secret:`.

## Security notes

- The key is in the URL. Anyone who sees the link (shell history, a terminal scrollback, a chat log) can read the note until it burns or expires.
- A password given on the command line ends up in your shell history. Prefer `read -s pw; secret send -p "$pw" …` or an environment variable.
- File names inside a note are chosen by whoever created it. `get` keeps only the final path segment, so `../../.ssh/authorized_keys` is saved as `authorized_keys` in the output directory.

## License

MIT — see [LICENSE](./LICENSE).
