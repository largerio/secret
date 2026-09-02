/** Exit codes, following the sysexits convention loosely: 2 = usage, 1 = failure. */
export const EXIT = {
	ok: 0,
	failure: 1,
	usage: 2,
} as const;

/**
 * The invocation itself is wrong: unknown option, missing argument, nothing to
 * send, no API key for a write. Reported with a pointer to `--help` and exit
 * code 2, so a script can tell a typo from a server that said no.
 */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

/**
 * The invocation was fine but the operation failed for a reason the SDK does
 * not model: a missing note on `check`, a file that already exists on `get`.
 */
export class CliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliError";
	}
}

/** The message of whatever was thrown — not everything that is thrown is an Error. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
