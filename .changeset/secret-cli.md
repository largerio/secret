---
"@largerio/secret-cli": minor
---

A command line for Secret: `secret`, installed with `npm install -g @largerio/secret-cli`. It works with any instance, from a terminal or a script, on Node 22 or later.

- `secret send` sends the text it reads on stdin, and the files named as arguments, a slice at a time, to the instance `--instance` or `SECRET_INSTANCE` names. It prints the link alone on stdout, so it can be piped; the expiry and the delete token go to stderr. `--max-reads`, `--expires` and `--password` set the note, `--format 0` writes to an instance older than 1.6.0.
- `secret read <link>` prints the text and writes the files to `--out`, the current directory by default. A file appears under its name only once the whole note is read and checked, and never overwrites one already there.
- `secret check <link>` tells whether a note is still there, without spending a read; `secret delete <link> --token <token>` deletes it.
- Writes use the API key in `SECRET_API_KEY` or `SECRET_API_KEY_FILE`, or else solve the instance's proof of work, as the browser does. A password comes from `SECRET_PASSWORD`, `--password-file` or a prompt on the terminal, never from an argument.
- `--json` prints one JSON value for scripts, and the exit code tells what happened: 0 done, 1 failed, 2 wrong usage, 3 no such note (expired, already read or deleted), 4 refused (a wrong password, link, delete token or API key), 130 interrupted.
