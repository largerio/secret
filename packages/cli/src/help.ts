// A named import, without `with { type: "json" }`, which allows only the
// default: the bundle inlines the version alone, not the whole manifest.
import { version } from "../package.json";

/** The package's version: inlined in the bundle, read from the manifest in the tests. */
export const VERSION: string = version;

export const COMMANDS = ["send", "read", "check", "delete"] as const;

export type CommandName = (typeof COMMANDS)[number];

export function isCommand(name: string): name is CommandName {
	return (COMMANDS as ReadonlyArray<string>).includes(name);
}

export const HELP = `Usage: secret <command> [options]

Sends and reads end-to-end encrypted notes on a Secret instance. A note is
encrypted here, before it is sent: the instance never sees its text, its
files or its key, which only the link holds.

Commands:
  send [file...]          Encrypt the text on stdin and the files, print the link
  read [link]             Decrypt a note: its text on stdout, its files on disk
  check <link>            Show what a note holds, without spending a read
  delete <link>           Delete a note before it expires, with its delete token
  help [command]          Show the help of a command

Options of every command:
  --json                  Print one JSON value on stdout, for a script
  -q, --quiet             Print neither progress nor information on stderr
  -h, --help              Show the help of the command

Environment:
  SECRET_INSTANCE         The instance send writes to, when --instance is not given
  SECRET_API_KEY          An API key, for send and delete; SECRET_API_KEY_FILE
                          names a file that holds one. Without a key, the
                          instance's proof of work is solved instead. Over
                          http, a key goes to this machine only, unless
                          --allow-http
  SECRET_PASSWORD         The password of a note, instead of asking for it
  SECRET_DEBUG=1          Show the stack of an unexpected error

Exit codes: 0 done, 1 failed, 2 wrong usage, 3 no such note, 4 refused (a
wrong password, link or delete token, a refused API key), 130 interrupted.

A link holds the key of its note: secret read takes it on stdin, or asks for
it, so that it stays out of the shell's history. Given as an argument, quote
it: some shells treat its # specially. secret --version shows the version.
`;

const SEND_HELP = `Usage: secret send [options] [file...]

Encrypts a note and prints its link on stdout, and nothing else. The link holds
the key: anyone who has it can read the note.

The text is read on stdin, to its end: piped in, or typed, then Ctrl-D. It is
never an argument, which the shell's history would keep: the arguments are
files, sent with the text or on their own.

Options:
  --instance <url>        The instance to write to (default: SECRET_INSTANCE)
  --max-reads <n>         Reads before the note is deleted, 0 for no limit
                          (default: 1)
  --expires <duration>    When the note is deleted, read or not: 30m, 1h, 7d,
                          2w, or seconds, from 5m to 30d (default: 24h, or the
                          instance's limit when it is lower)
  --password              The reader needs a password too: SECRET_PASSWORD,
                          the --password-file, or asked twice on the terminal
  --password-file <path>  The first line of this file is the password
  --mode <mode>           How the text is shown: text, markdown or secret
  --format <0|1>          The note's format (default: 1); 0 for an instance
                          older than 1.6.0
  --allow-http            Send the API key over http to another machine,
                          where anyone on the way can read it
  --json                  Print {link, id, expiresAt, deleteToken, maxReads}
  -q, --quiet             Print neither progress nor the delete token

Examples:
  secret send < notes.txt
  echo "the code is 0000" | secret send --expires 1h
  secret send --password report.pdf < message.txt
`;

const READ_HELP = `Usage: secret read [link] [options]

Decrypts a note: its text on stdout, its files in a directory. This spends one
of the note's reads, and its last read deletes it.

Without an argument, the link is the first line of stdin when it is piped in,
or else it is asked on the terminal, and not shown. Given as an argument, it
stays in the shell's history and shows in the list of processes.

A file is written under the name its sender gave it, made safe, beside what is
there and never over it, once the whole note is verified. On a terminal, the
control characters of the text are shown, not run.

Options:
  -o, --out <dir>         Where the files go (default: the current directory)
  --password-file <path>  The first line of this file is the password (default:
                          SECRET_PASSWORD, or asked on the terminal)
  --json                  Print {text, contentMode, files, createdAt, expiresAt}
  -q, --quiet             Print neither progress nor the files written
`;

const CHECK_HELP = `Usage: secret check <link> [options]

Shows what is known of a note without reading it, which spends nothing: its
password, files, expiry, reads and format. Exits with 3 when there is no such
note. The link may be given without its key, the part after #.

Options:
  --json                  Print what the instance answers
`;

const DELETE_HELP = `Usage: secret delete <link> --token=<deleteToken>

Deletes a note before it expires, with the delete token that send printed. The
link may be given without its key, the part after #.

Options:
  --token=<deleteToken>   The note's delete token, after an =: a token may
                          start with a dash
  --allow-http            Send the API key over http to another machine,
                          where anyone on the way can read it
  --json                  Print {deleted: true}
  -q, --quiet             Print nothing once the note is deleted
`;

const COMMAND_HELP: Record<CommandName, string> = {
	send: SEND_HELP,
	read: READ_HELP,
	check: CHECK_HELP,
	delete: DELETE_HELP,
};

export function commandHelp(command: CommandName): string {
	return COMMAND_HELP[command];
}
