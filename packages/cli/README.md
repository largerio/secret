# @largerio/secret-cli

The command line for [Secret](https://github.com/largerio/secret). It sends and reads end-to-end encrypted notes and files on any Secret instance, from a terminal or a script.

Notes are encrypted **on your machine** before anything is sent, by the same [SDK](https://www.npmjs.com/package/@largerio/secret-sdk) the web app uses. The instance stores what it can't read: the key is in the link, and nowhere else.

```bash
npm install -g @largerio/secret-cli
secret --help
```

You can also run it without installing it: `npx @largerio/secret-cli --help`. It needs Node.js 22 or later.

## Quick start

```bash
export SECRET_INSTANCE=https://secret.example.com   # the instance send writes to

echo "the launch code is 0000" | secret send --expires 1h
# → https://secret.example.com/note/aBcDeFgHiJkL#1.K7pQ...

secret send --password report.pdf < message.txt     # a text, a file and a password

secret read                                         # asks for the link, without echo
pbpaste | secret read --out ~/Downloads             # or takes it on stdin
```

`send` prints only the link on stdout, so you can pipe it (`| pbcopy`); the expiry and the delete token go to stderr. `read` prints the text on stdout, and writes the files to the current directory, or to `--out`.

## Instances and access

There's no default instance. `send` writes to the one named by `--instance <url>` or `SECRET_INSTANCE`: an `http:` or `https:` URL, including its path if the instance is served under one. `read`, `check` and `delete` talk to the link's instance, and take no `--instance`.

Reading is open on every instance. Writing (`send`, `delete`) needs one of two things:

- **An API key**, in `SECRET_API_KEY`, or in the file named by `SECRET_API_KEY_FILE` (set one or the other; surrounding blanks and line endings are dropped). Keys come from the instance's operator, who sets them in its environment ([API keys](https://github.com/largerio/secret/blob/main/docs/self-hosting.md#api-keys-for-the-sdk)). There's no option for the key, because an argument stays in the shell's history and shows up in `ps`. If the instance refuses the key, the command fails (exit 4) rather than falling back on a proof of work.
- **A proof of work**, without a key. The command solves the instance's challenge, as the browser does, and gets a token good for one write. That takes a few seconds at the default difficulty. The command refuses a challenge beyond [its bounds](https://github.com/largerio/secret/blob/main/PROTOCOL.md#proof-of-work): on such an instance, or one that keeps its challenge behind a login, write with a key.

An API key is never sent over plain `http:`, where it would cross the network in clear, except to this machine (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`). `--allow-http` sends it anyway. Without a key, `http:` is accepted.

Before encrypting anything, `send` reads the instance's limits (`GET /api/v1/config`). A note the instance would refuse (too many files, files too large, an expiry beyond its limit) is refused right there, and the note goes up in chunks no larger than the instance accepts. Instances older than 1.6.0 only accept format 0: write to them with `--format 0`.

## Commands

### `secret send [options] [file...]`

Encrypts a note and prints its link on stdout, and nothing else.

- **The text** is read from stdin, to the end: piped in, or typed after the prompt and ended with Ctrl-D. It's sent exactly as is, and must be UTF-8 text of at most 102,400 characters; send anything else as a file. The text is never an argument. When stdin is a terminal and files are given, the note has no text, and nothing is asked. A script's stdin often isn't a terminal, so it's read as the text: use `< /dev/null` to send files alone.
- **The files** are the arguments. Each must be a regular file, and is sent under its base name, with a MIME type guessed from its extension (`application/octet-stream` otherwise). Files are read a slice at a time, never whole into memory. Directories are refused: send an archive instead.

| Option | |
|---|---|
| `--instance <url>` | The instance to write to (default: `SECRET_INSTANCE`) |
| `--max-reads <n>` | Reads before the note is deleted, 0 to 1000, `0` for no limit (default: 1) |
| `--expires <duration>` | When the note is deleted, read or not: `90s`, `30m`, `1h`, `7d`, `2w`, or a number of seconds, from 5 minutes to 30 days and within the instance's limit (default: 24 hours, or the instance's limit if lower) |
| `--password` | The reader needs a password too: see [Passwords](#passwords) |
| `--password-file <path>` | The password is the first line of this file; implies `--password` |
| `--mode <mode>` | How the web app shows the text: `text`, `markdown`, or `secret` (a password, a key) |
| `--format <0\|1>` | The note's format (default: 1); `0` for an instance older than 1.6.0 |
| `--allow-http` | Send the API key over plain `http:` to a host other than this machine |
| `--json` | Print `{link, id, expiresAt, deleteToken, maxReads}` |
| `-q, --quiet` | Print neither progress nor information, the delete token included |

Once the note is sent, stderr says when it expires, how many reads it allows, and how to delete it sooner:

```
Expires 2026-11-06T13:00:00.000Z, in 1h; it is deleted once read.
Delete token: <token>
To delete it sooner: secret delete https://secret.example.com/note/aBcDeFgHiJkL --token=<token>
```

`--quiet` leaves out the delete token too; `--json` keeps it.

### `secret read [link] [options]`

Decrypts a note: the text goes to stdout, the files to disk. This spends one of the note's reads. When it's the last one, the note is deleted, and `read` says so on stderr.

The link is the argument if there is one. Otherwise it's the first line of stdin, when stdin isn't a terminal, or else `read` asks for it on the terminal, without echo. Prefer stdin or the prompt: see [Security](#security).

Before spending the read, `read` checks that the note exists (exit 3 otherwise) and that the directory for its files exists and is writable, and asks for the password if the note has one. On a terminal, the text is shown made safe, and ends with a line break; redirected, it's written byte for byte. The files are written as described in [Files received](#files-received).

| Option | |
|---|---|
| `-o, --out <dir>` | Where the files go: an existing directory (default: the current directory) |
| `--password-file <path>` | The password is the first line of this file |
| `--json` | Print `{text, contentMode, files, createdAt, expiresAt}` |
| `-q, --quiet` | Print neither progress nor the files written |

### `secret check <link> [options]`

Shows what the instance knows about a note, without spending a read: whether it has a password, its files, expiry, reads and format. Exits with 3 if there's no such note.

```
$ secret check https://secret.example.com/note/aBcDeFgHiJkL
Password: yes, 5 wrong ones before the note is deleted
Files:    1
Expires:  2026-11-06T13:00:00.000Z
Reads:    1 left of 1
Format:   1
```

It only needs the note's id, so give it the link without its `#…` fragment; it ignores the fragment anyway.

| Option | |
|---|---|
| `--json` | Print what the instance answers, the SDK's `NoteInfo` |

### `secret delete <link> --token=<deleteToken>`

Deletes a note before it expires, with the delete token `send` printed. Like `send`, it needs an API key or a proof of work. If the note is already gone, it exits with 3 without solving anything. A wrong token exits with 4. Like `check`, it only needs the note's id, so give it the link without its fragment.

Write the token with `=`: a token can start with `-`, which `--token <deleteToken>` would read as an option.

| Option | |
|---|---|
| `--token=<deleteToken>` | The note's delete token |
| `--allow-http` | Send the API key over plain `http:` to a host other than this machine |
| `--json` | Print `{deleted: true}` |
| `-q, --quiet` | Print nothing once the note is deleted |

### Help and version

`secret --help`, `secret help <command>` or `secret <command> --help`, and `secret --version`.

## Passwords

`send --password` protects the note with a password, and so does `--password-file`. `read` asks for one when the note has one. Both take the password from the first of:

1. `SECRET_PASSWORD`, if it's set;
2. the first line of `--password-file <path>`, without its line ending;
3. the terminal, without echo, twice for `send`. The prompt appears on the controlling terminal, never on stdin, which may carry the text or the link. Where there's no terminal (a CI job, cron, Windows), use one of the other two, or the command exits with 2.

`SECRET_PASSWORD` alone doesn't protect a note: `send` needs `--password`. An empty password counts as no password, and is refused.

What a wrong password costs depends on the note's format, which `check` shows:

- **Format 1**, which `send` writes: the instance checks a proof of the password before serving anything, so a wrong password spends no read. The fifth wrong one over the note's life deletes it. On a terminal, `read` asks again, shows the attempts left, and warns you when the next wrong one would delete the note; once fewer than five attempts are left, its first prompt shows them too. A password given by `SECRET_PASSWORD` or a file is tried only once: if it's wrong, it counts as an attempt, and `read` exits with 4.
- **Format 0**, the legacy format, which `send --format 0` writes: the instance serves the note before the password can be checked, so a wrong password spends a read, which may be the only read of a burn-after-read note. `read` warns you before asking, and tells you when it fails (exit 4).

## Files received

`read` writes a note's files to `--out`, the current directory by default, after checking that it can, and before spending the read. The sender chooses the files' names and contents, so:

- **Names are made safe.** Only the last segment of the name is kept, after any `/` or `\`. Control characters, invisible format characters (bidirectional overrides included) and `< > : " | ? *` become `_`. Leading dots, dashes and spaces are removed, so that no hidden file such as `.bashrc` appears and no name reads as an option, and so are trailing dots and spaces. A Windows device name (`CON`, `NUL`, `COM1`…) gets a leading `_`, an empty name becomes `file-<n>`, and a long one is cut to 255 bytes, keeping its extension.
- **Nothing is overwritten.** A name already taken on disk (by a file, a directory or a link), or by another file of the note, compared the way a case-insensitive file system would, gets the first free suffix: `report (1).pdf`, `report (2).pdf`…
- **A file only appears under its name once the note is verified.** It's written to `<name>.part`, created exclusively (never through a link) and readable only by you (mode `0600`), then renamed once the whole note has been read and checked. If the note is refused, damaged or truncated, or the read is interrupted, its `.part` files are removed.
- **Files never go to stdout.** A format 1 note is only checked at its end, and bytes already printed can't be taken back.

For each file written, stderr shows its path and size; `--json` lists them in `files`, with `name` as the sender gave it and `path` as it was written.

## Output and `--json`

stdout carries only the result: the link, the text, or `check`'s lines. stderr carries everything else: information (none with `--quiet`), errors, and, on a terminal, a progress line that is rewritten in place and erased at the end.

With `--json`, the command prints a single JSON value on stdout, on one line, and no information on stderr, which still carries the errors and, on a terminal, the progress line.

| Command | JSON |
|---|---|
| `send` | `{"link", "id", "expiresAt", "deleteToken", "maxReads"}` |
| `read` | `{"text", "contentMode", "files": [{"name", "path", "type", "size"}], "createdAt", "expiresAt"}`, without `text` or `contentMode` when the note has none |
| `check` | The SDK's `NoteInfo`: `{"exists": false}` (exit 3), or `"exists": true` with `hasPassword`, `fileCount`, `expiresAt`, `maxReads`, `readCount`, `chunked`, and for a format 1 note, `envelope` and, with a password, `passwordAttemptsLeft` |
| `delete` | `{"deleted": true}` |

## Exit codes

| Code | |
|---|---|
| 0 | Done |
| 1 | Failed: the network, the instance, the disk, the proof of work |
| 2 | Wrong usage: an unknown option, an invalid value, a missing argument, a link that names no note, a note the instance would refuse (`send` checks its limits first) |
| 3 | No such note: it expired, its reads were spent, it was deleted, or it never existed |
| 4 | Refused: a wrong password, a wrong or damaged link, a tampered note, a wrong delete token, a refused API key |
| 129 | Interrupted by SIGHUP |
| 130 | Interrupted by Ctrl-C (SIGINT) |
| 143 | Interrupted by SIGTERM |

A link whose id isn't 12 characters from `A-Z a-z 0-9 _ -` exits with 2. One whose key is malformed, or names a format this version doesn't know (`#2.…`), exits with 4. Both happen before any request that would spend a read.

An interruption removes the files not yet complete, and a second Ctrl-C kills the command at once. A read the instance has started to serve is still spent.

An error is a single line on stderr, `secret: <message>`, which never includes the link, a key or a password.

## Environment

| Variable | |
|---|---|
| `SECRET_INSTANCE` | The instance `send` writes to, when `--instance` isn't given |
| `SECRET_API_KEY` | An API key, for `send` and `delete` |
| `SECRET_API_KEY_FILE` | The path of a file holding the API key, instead |
| `SECRET_PASSWORD` | A note's password, for `send --password` and `read` |
| `SECRET_DEBUG=1` | Show the stack trace of an unexpected error |

## Scripts and CI

```bash
# Files alone: the link to the clipboard
tar czf logs.tgz logs/
secret send --expires 1d logs.tgz < /dev/null | pbcopy

# Keep the delete token, and delete the note later
note=$(secret send --json --max-reads 3 < credentials.txt)
link=$(jq -r .link <<< "$note")
token=$(jq -r .deleteToken <<< "$note")
secret delete "${link%%#*}" --token="$token"

# What became of a note: check spends nothing, and needs no key
secret check "${link%%#*}" > /dev/null
case $? in
  0) echo "not read yet" ;;
  3) echo "read, expired or deleted" ;;
  *) echo "could not tell" ;;
esac
```

A CI job has no terminal, so the text comes from stdin, and a password from `SECRET_PASSWORD` or `--password-file`. In GitHub Actions, with the instance in a variable and the key in a secret:

```yaml
- uses: actions/setup-node@v7
  with:
    node-version: 22
- name: Send the report
  env:
    SECRET_INSTANCE: ${{ vars.SECRET_INSTANCE }}
    SECRET_API_KEY: ${{ secrets.SECRET_API_KEY }}
  run: |
    link=$(echo "Report of run $GITHUB_RUN_ID" | npx --yes @largerio/secret-cli send --expires 7d report.pdf)
    echo "::add-mask::$link"
    # Hand "$link" on through a private channel: never the job's log.
```

## Security

- **The link is the key.** Whoever holds it can read the note, given the password if it has one. Share it the way you would share the secret itself.
- **Give `read` the link on stdin or at its prompt**, not as an argument: an argument stays in the shell's history, and shows up in `ps` for the machine's other users. `check` and `delete` only need the note's id, so give them the link without its `#…` fragment. No option takes the text, the API key or a password: they come from stdin, the environment, a file or the terminal. The delete token is an argument of `delete`, but it can only delete the note.
- **The link goes to stdout, and nowhere else**: never to stderr, nor into an error message, so a log of stderr holds no key.
- **What comes from a note is shown, not run.** On a terminal, its text and the names of its files have their control characters (C0 except line feed and tab, DEL, C1, including the escape that drives a terminal) and invisible format characters (bidirectional overrides included) replaced before they're shown. Redirected to a file or a program, the text is exact, so whatever reads it must not trust it.
- **Received files** only go inside `--out`, under safe names, over nothing, and only once verified: see [Files received](#files-received). Their contents come from the sender.
- **An API key never crosses the network in clear**, unless `--allow-http` says so.

[SECURITY.md](https://github.com/largerio/secret/blob/main/SECURITY.md) covers Secret's threat model, what an instance learns, and the known limitations; [PROTOCOL.md](https://github.com/largerio/secret/blob/main/PROTOCOL.md) covers the format.

## License

[MIT](https://github.com/largerio/secret/blob/main/packages/cli/LICENSE)
