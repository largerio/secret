import type { Command } from "./args.js";
import { ENV_API_KEY, ENV_SERVER_URL } from "./config.js";

const CONNECTION_HELP = `Connection:
  -s, --server <url>     Secret instance to talk to (env: ${ENV_SERVER_URL})
  -k, --api-key <key>    API key; required by send and delete (env: ${ENV_API_KEY})`;

const COMMAND_HELP: Readonly<Record<Command, string>> = {
	send: `Usage: secret send [files...] [options]

Encrypt text and/or files locally and upload them. Text comes from --text or,
when something is piped in, from stdin. Prints the share URL on stdout; the
delete token and expiry go to stderr so the URL alone can be piped onward.

Options:
  -t, --text <text>      Text to send (instead of stdin)
  -p, --password <pw>    Also protect the note with a password
  -b, --burn             Burn after the first read (the default)
  -r, --reads <n>        Allow n reads before the note is deleted (0 = unlimited)
  -e, --expires <dur>    Expiry: seconds, or 30m, 2h, 7d (default: 24h)
      --json             Print { url, id, deleteToken, expiresAt } as JSON
  -h, --help             Show this help

${CONNECTION_HELP}

Examples:
  echo "the launch code is 0000" | secret send
  secret send --text "rotate me" --reads 3 --expires 2h
  secret send report.pdf photo.png --password hunter2`,
	get: `Usage: secret get <url> [options]

Download a note and decrypt it with the key from the URL fragment. Text is
printed on stdout; files are saved to the output directory. This consumes a
read: on a burn-after-read note there is no second chance, so a
password-protected note is refused before download when --password is missing.

Options:
  -p, --password <pw>    Password the note was protected with
  -o, --out <dir>        Directory to save files into (default: current directory)
  -f, --force            Overwrite existing files (default: save under a numbered name)
  -h, --help             Show this help

${CONNECTION_HELP}
  The instance is taken from the URL when --server and ${ENV_SERVER_URL} are unset.

Example:
  secret get "https://secret.example.com/note/aBcDeFgHiJkL#K7pQ…" --out ./downloads`,
	check: `Usage: secret check <url> [options]

Show a note's metadata without consuming a read. Exits 1 when the note is
gone — expired, burned, or never existed (the instance does not tell which).

Options:
      --json             Print the metadata as JSON
  -h, --help             Show this help

${CONNECTION_HELP}
  The instance is taken from the URL when --server and ${ENV_SERVER_URL} are unset.`,
	delete: `Usage: secret delete <url> <deleteToken> [options]

Delete a note before it expires, using the delete token printed by send.

Options:
  -h, --help             Show this help

${CONNECTION_HELP}
  The instance is taken from the URL when --server and ${ENV_SERVER_URL} are unset.`,
};

const GENERAL_HELP = `Usage: secret <command> [options]

Zero-knowledge encrypted notes and files from the command line. Everything is
encrypted before it leaves this machine; the key travels in the URL fragment.

Commands:
  send [files...]              Encrypt and upload text (stdin or --text) and/or files
  get <url>                    Download and decrypt a note
  check <url>                  Show a note's metadata without consuming a read
  delete <url> <deleteToken>   Delete a note before it expires

${CONNECTION_HELP}

Other:
  -h, --help             Show this help (secret <command> --help for a command)
  -V, --version          Show the version

Reads work against any instance. Writes (send, delete) need an API key from
the instance operator: there is no sign-up, and the Proof-of-Work path the web
UI uses is browser-only.`;

/** Help text for the CLI or for one command, ending with a newline. */
export function usage(command?: Command): string {
	return `${command === undefined ? GENERAL_HELP : COMMAND_HELP[command]}\n`;
}
