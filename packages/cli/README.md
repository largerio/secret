# @largerio/secret-cli

Command line for [Secret](https://github.com/largerio/secret): send and read zero-knowledge, end-to-end encrypted notes and files on any Secret instance, from a terminal or a script.

A note is encrypted **on your machine**, by the [SDK](https://www.npmjs.com/package/@largerio/secret-sdk) the web app runs too, before anything is sent. The instance stores what it cannot read: the key is in the link, and nowhere else.

```bash
npm install -g @largerio/secret-cli
secret --help
```

Or without installing it: `npx @largerio/secret-cli --help`. Requires Node.js 22 or later.

## Quick start

```bash
export SECRET_INSTANCE=https://secret.example.com   # the instance send writes to

echo "the launch code is 0000" | secret send --expires 1h
# → https://secret.example.com/note/aBcDeFgHiJkL#1.K7pQ...

secret send --password report.pdf < message.txt     # a text, a file and a password

secret read                                         # asks for the link, without echo
pbpaste | secret read --out ~/Downloads             # or takes it on stdin
```

`send` prints the link alone on stdout, so it pipes (`| pbcopy`); the expiry and the delete token go to stderr. `read` prints the text on stdout and writes the files to the current directory, or to `--out`.

## Instances and access

There is no default instance. `send` writes to the one `--instance <url>` or `SECRET_INSTANCE` names: an `http:` or `https:` URL, with its path when the instance is served under one. `read`, `check` and `delete` talk to the instance of the link, and take no `--instance`.

Reads are open on every instance. Writes (`send`, `delete`) need one of two things:

- **An API key**, in `SECRET_API_KEY`, or in the file `SECRET_API_KEY_FILE` names (blanks and line endings around it are dropped; set one or the other). A key is the operator's to give: it is a value set in the instance's environment ([API keys](https://github.com/largerio/secret/blob/main/docs/self-hosting.md#api-keys-for-the-sdk)). There is no option for it, since an argument stays in the shell's history and shows in `ps`. A key the instance refuses is an error (exit 4): the command does not fall back on a proof of work.
- **Without a key, a proof of work.** The command solves the instance's challenge, as the browser does, for a token that lets in one write: a few seconds at an instance's default difficulty. It refuses a challenge beyond [its bounds](https://github.com/largerio/secret/blob/main/PROTOCOL.md#proof-of-work); write with a key there, and on an instance that keeps its challenge behind a login.

An API key is not sent over plain `http:` to any host but this machine (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), where it would cross the network in clear: `--allow-http` sends it anyway. Without a key, `http:` is accepted.

Before it encrypts anything, `send` reads the instance's limits (`GET /api/v1/config`): a note the instance would refuse (too many files, files too large, an expiry beyond its limit) is refused there, and the note goes up in chunks no larger than the instance takes. An instance older than 1.6.0 takes format 0 only: write to it with `--format 0`.

## Commands

### `secret send [options] [file...]`

Encrypts a note and prints its link on stdout, and nothing else.

- **The text** is read on stdin, to its end: piped in, or typed after the prompt, then Ctrl-D. It is sent exactly as it is, and must be UTF-8 text of at most 102,400 characters: send anything else as a file. It is never an argument. When stdin is a terminal and files are named, the note has no text and nothing is asked. A script's stdin is often not a terminal, and is then read as the text: `< /dev/null` sends files alone.
- **The files** are the arguments: regular files, each sent under its base name, with a MIME type guessed from its extension (`application/octet-stream` otherwise), and read a slice at a time, never whole in memory. A directory is refused: send an archive of it.

| Option | |
|---|---|
| `--instance <url>` | The instance to write to (default: `SECRET_INSTANCE`) |
| `--max-reads <n>` | Reads before the note is deleted, 0 to 1000, `0` for no limit (default: 1) |
| `--expires <duration>` | When the note is deleted, read or not: `90s`, `30m`, `1h`, `7d`, `2w`, or a number of seconds, from 5 minutes to 30 days and within the instance's limit (default: 24 hours, or the instance's limit when it is lower) |
| `--password` | The reader needs a password too: see [Passwords](#passwords) |
| `--password-file <path>` | The password is the first line of this file; implies `--password` |
| `--mode <mode>` | How the web app shows the text: `text`, `markdown`, or `secret` (a password, a key) |
| `--format <0\|1>` | The note's format (default: 1); `0` for an instance older than 1.6.0 |
| `--allow-http` | Send the API key over plain `http:` to a host that is not this machine |
| `--json` | Print `{link, id, expiresAt, deleteToken, maxReads}` |
| `-q, --quiet` | Print neither progress nor information, the delete token included |

Once the note is sent, stderr tells when it expires, how many reads it takes, and how to delete it sooner:

```
Expires 2026-11-06T13:00:00.000Z, in 1h; it is deleted once read.
Delete token: <token>
To delete it sooner: secret delete https://secret.example.com/note/aBcDeFgHiJkL --token=<token>
```

`--quiet` leaves the delete token out too: `--json` keeps it.

### `secret read [link] [options]`

Decrypts a note: its text on stdout, its files on disk. This spends one of the note's reads. When it's the last one, the note is deleted, and `read` says so on stderr.

The link is the argument, or else the first line of stdin when stdin is not a terminal, or else it is asked on the terminal, without echo. Prefer stdin or the prompt: see [Security](#security).

Before it spends the read, `read` checks that the note exists (exit 3 otherwise) and that the directory its files go to exists and can be written, and asks for the password of a password note. On a terminal, the text is shown made safe, ending with a line break; redirected, it is written byte for byte. The files are written as [Files received](#files-received) says.

| Option | |
|---|---|
| `-o, --out <dir>` | Where the files go: a directory that exists (default: the current directory) |
| `--password-file <path>` | The password is the first line of this file |
| `--json` | Print `{text, contentMode, files, createdAt, expiresAt}` |
| `-q, --quiet` | Print neither progress nor the files written |

### `secret check <link> [options]`

Shows what the instance knows of a note, without spending a read: its password, files, expiry, reads and format. Exits with 3 when there is no such note.

```
$ secret check https://secret.example.com/note/aBcDeFgHiJkL
Password: yes, 5 wrong ones before the note is deleted
Files:    1
Expires:  2026-11-06T13:00:00.000Z
Reads:    1 left of 1
Format:   1
```

It needs only the note's id: give it the link without its `#…` fragment, which it ignores anyway.

| Option | |
|---|---|
| `--json` | Print what the instance answers, the SDK's `NoteInfo` |

### `secret delete <link> --token=<deleteToken>`

Deletes a note before it expires, with the delete token `send` printed. Like `send`, it needs an API key or a proof of work; when the note is already gone, it exits with 3 without solving anything. A wrong token exits with 4. Like `check`, it needs only the note's id: give it the link without its fragment.

Write the token with `=`: a token may start with `-`, which `--token <deleteToken>` would read as an option.

| Option | |
|---|---|
| `--token=<deleteToken>` | The note's delete token |
| `--allow-http` | Send the API key over plain `http:` to a host that is not this machine |
| `--json` | Print `{deleted: true}` |
| `-q, --quiet` | Print nothing once the note is deleted |

### Help and version

`secret --help`, `secret help <command>` or `secret <command> --help`, and `secret --version`.

## Passwords

`send --password` gives the note a password, as `--password-file` does. `read` asks for one when the note has one. Both take it from the first of:

1. `SECRET_PASSWORD`, when it is set;
2. the first line of `--password-file <path>`, as it is but for its line ending;
3. the terminal, without echo, twice for `send`. The prompt is on the controlling terminal, never on stdin, which may carry the text or the link. Where there is none (a CI job, cron, Windows), set one of the other two, or the command exits with 2.

`SECRET_PASSWORD` alone does not give a note a password: `send` needs `--password`. An empty password is no password, and is refused.

What a wrong password costs depends on the note's format, which `check` shows:

- **Format 1**, which `send` writes: the instance checks a proof of the password before it serves anything, so a wrong password spends no read. The fifth wrong one, over the note's life, deletes the note. On a terminal, `read` asks again, with the attempts left, and warns when the next wrong one deletes the note; its first prompt gives the attempts left too, once fewer than five are. A password given by `SECRET_PASSWORD` or a file is tried once: wrong, it counts an attempt, and `read` exits with 4.
- **Format 0**, the legacy format, which `send --format 0` writes: the instance serves the note before the password can be checked, so a wrong password spends a read, the only one of a burn-after-read note. `read` warns before it asks, and says so when it fails (exit 4).

## Files received

`read` writes a note's files to `--out`, the current directory by default, and checks that it can before it spends the read. The sender picks the files' names and bytes, so:

- **Names are made safe.** Only the last segment of the name sent is kept, after any `/` or `\`. Control characters, invisible format characters (bidirectional overrides among them) and `< > : " | ? *` become `_`. Leading dots, dashes and spaces are dropped, so that no hidden file such as `.bashrc` appears and no name reads as an option; trailing dots and spaces too. A Windows device name (`CON`, `NUL`, `COM1`…) takes a leading `_`, a name left empty becomes `file-<n>`, and a long one is cut to 255 bytes, its extension kept.
- **Nothing is overwritten.** A name already taken, on disk (by a file, a directory or a link) or by another file of the note, compared as a case-insensitive file system would, gets the first free suffix: `report (1).pdf`, `report (2).pdf`…
- **A file shows under its name only once the note is verified.** It is written to `<name>.part`, created exclusively (never through a link) and readable by you alone (mode `0600`), then renamed once the whole note is read and checked. If the note is refused, damaged or cut short, or the read is interrupted, its `.part` files are removed.
- **Never on stdout.** A format 1 note is checked only at its end, and bytes already printed cannot be taken back.

For each file written, stderr gives its path and size; `--json` gives them in `files`, with `name` as the sender gave it and `path` as it was written.

## Output and `--json`

stdout carries the result alone: the link, the text, or `check`'s lines. stderr carries the rest: information (none with `--quiet`), errors, and on a terminal a progress line, rewritten in place and erased at the end.

`--json` prints one JSON value on stdout, on one line, and no information on stderr, which keeps the errors and, on a terminal, the progress line.

| Command | JSON |
|---|---|
| `send` | `{"link", "id", "expiresAt", "deleteToken", "maxReads"}` |
| `read` | `{"text", "contentMode", "files": [{"name", "path", "type", "size"}], "createdAt", "expiresAt"}`, without `text` or `contentMode` when the note has none |
| `check` | The SDK's `NoteInfo`: `{"exists": false}` (exit 3), or `"exists": true` with `hasPassword`, `fileCount`, `expiresAt`, `maxReads`, `readCount`, `chunked`, and for a format 1 note `envelope` and, with a password, `passwordAttemptsLeft` |
| `delete` | `{"deleted": true}` |

## Exit codes

| Code | |
|---|---|
| 0 | Done |
| 1 | Failed: the network, the instance, the disk, the proof of work |
| 2 | Wrong usage: an unknown option, an invalid value, a missing argument, a link that names no note, a note the instance would refuse (`send` checks its limits first) |
| 3 | No such note: it expired, its reads were spent, it was deleted, or it never existed |
| 4 | Refused: a wrong password, a link wrong or damaged, a note tampered with, a wrong delete token, a refused API key |
| 129 | Interrupted by SIGHUP |
| 130 | Interrupted by Ctrl-C (SIGINT) |
| 143 | Interrupted by SIGTERM |

A link whose id is not 12 characters of `A-Z a-z 0-9 _ -` exits with 2, and one whose key is malformed or names a format this version does not know (`#2.…`) with 4, before any request that would spend a read.

An interruption removes the files not yet complete; a second Ctrl-C kills the command at once. A read the instance has started to serve is spent all the same.

An error is one line on stderr, `secret: <message>`, which names neither the link, nor a key, nor a password.

## Environment

| Variable | |
|---|---|
| `SECRET_INSTANCE` | The instance `send` writes to, when `--instance` is not given |
| `SECRET_API_KEY` | An API key, for `send` and `delete` |
| `SECRET_API_KEY_FILE` | The path of a file that holds the API key, instead |
| `SECRET_PASSWORD` | The password of a note, for `send --password` and `read` |
| `SECRET_DEBUG=1` | Show the stack of an unexpected error |

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

A job has no terminal: the text comes on stdin, and a password from `SECRET_PASSWORD` or `--password-file`. In GitHub Actions, with the instance in a variable and the key in a secret:

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

- **The link is the key.** Whoever holds it reads the note, given its password for a password note. Send it as you would send the secret.
- **Give `read` the link on stdin or at its prompt**, not as an argument: an argument stays in the shell's history and shows in `ps` to the machine's other users. `check` and `delete` need only the note's id: give them the link without its `#…` fragment. No option takes the text, the API key or a password: they come from stdin, the environment, a file or the terminal. The delete token, an argument of `delete`, can only delete the note.
- **The link goes to stdout, and nowhere else**: never to stderr, nor into an error message, so a log of stderr holds no key.
- **What comes from a note is shown, not run.** On a terminal, its text and the names of its files have their control characters (C0 but line feed and tab, DEL, C1, the escape that drives a terminal among them) and invisible format characters (bidirectional overrides among them) replaced before they are shown. Redirected to a file or a program, the text is exact: what reads it must not trust it.
- **Received files** go inside `--out` only, under safe names, over nothing, once verified: see [Files received](#files-received). Their contents are the sender's.
- **An API key does not cross the network in clear**, unless `--allow-http` says so.

Secret's threat model, what an instance learns, and the known limitations are in [SECURITY.md](https://github.com/largerio/secret/blob/main/SECURITY.md); the format, in [PROTOCOL.md](https://github.com/largerio/secret/blob/main/PROTOCOL.md).

## License

[MIT](https://github.com/largerio/secret/blob/main/packages/cli/LICENSE)
