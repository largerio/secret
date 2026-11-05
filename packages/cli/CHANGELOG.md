# @largerio/secret-cli

## 0.1.0

### Minor Changes

- f5dc50b: A command line for Secret: `secret`, installed with `npm install -g @largerio/secret-cli`. It works with any instance, from a terminal or a script, on Node 22 or later.
  
  - `secret send` sends the text piped in on stdin, or typed on the terminal, and the files named as arguments, read a slice at a time, to the instance `--instance` or `SECRET_INSTANCE` names. It prints the link alone on stdout, so it can be piped; the expiry and the delete token go to stderr. `--max-reads`, `--expires`, `--password` and `--mode` set the note, `--format 0` writes to an instance older than 1.6.0.
  - `secret read` takes the link on stdin, or asks for it on the terminal without echo, which keeps it out of the shell's history and of `ps`; an argument works too. It prints the text and writes the files to `--out`, the current directory by default. A file appears under its name only once the whole note is read and checked, and never overwrites one already there. On a terminal, a wrong password is asked again while the note takes attempts, and the text's control and invisible format characters are shown, not run. A link whose id or key is malformed is refused before a read is spent.
  - `secret check <link>` shows what a note holds, its password, files, expiry, reads left and format, without spending a read; `secret delete <link> --token=<token>` deletes it. Both need only the note's id: the link can be given without its key.
  - Writes use the API key in `SECRET_API_KEY` or `SECRET_API_KEY_FILE`, or else solve the instance's proof of work, as the browser does. The key is not sent over plain `http:` to another machine unless `--allow-http` says so. A password comes from `SECRET_PASSWORD`, `--password-file` or a prompt on the terminal, never from an argument.
  - `--json` prints one JSON value for scripts, `--quiet` nothing on stderr but errors, and the exit code tells what happened: 0 done, 1 failed, 2 wrong usage, 3 no such note (expired, already read or deleted), 4 refused (a wrong password, link, delete token or API key), and 130, 143 or 129 once interrupted by Ctrl-C, SIGTERM or SIGHUP.

### Patch Changes

- Updated dependencies [f5dc50b]
- Updated dependencies [f5dc50b]
  - @largerio/secret-sdk@1.5.0
