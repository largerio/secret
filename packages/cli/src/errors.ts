/** The exit codes of the command, the scripts' to branch on. */
export const EXIT = {
	ok: 0,
	failure: 1,
	usage: 2,
	notFound: 3,
	refused: 4,
	interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * The signals that stop a command as Ctrl-C does, its partial files removed,
 * and the code it then exits with: 128 and the signal's number, as a shell
 * tells of a command the signal killed.
 */
export const SIGNAL_EXIT: Readonly<Record<string, number>> = {
	SIGINT: EXIT.interrupted,
	SIGHUP: 129,
	SIGTERM: 143,
};

/** A failure the command reports in its own words, then exits with `exitCode`. */
export class CliError extends Error {
	readonly exitCode: ExitCode;

	constructor(message: string, exitCode: ExitCode = EXIT.failure, options?: ErrorOptions) {
		super(message, options);
		this.name = "CliError";
		this.exitCode = exitCode;
	}
}

/** The code of a failed system call or of Node's own failure, `ENOENT` say; undefined for any other. */
export function errnoOf(err: unknown): string | undefined {
	if (!(err instanceof Error)) {
		return undefined;
	}
	const { code } = err as NodeJS.ErrnoException;
	return typeof code === "string" ? code : undefined;
}

/** What the codes the user can act on mean. */
const REASONS: Readonly<Record<string, string>> = {
	ENOENT: "no such file or directory",
	ENOTDIR: "not a directory",
	ENOSPC: "the disk is full",
	EDQUOT: "the disk quota is exceeded",
	EFBIG: "the file is too large for this file system",
	EACCES: "permission denied",
	EPERM: "permission denied",
	EROFS: "the file system is read-only",
	ENAMETOOLONG: "the file system refused the name as too long",
	EIO: "an input/output error",
	EBUSY: "the file is in use",
};

/**
 * Why a call to the file system failed: what its code means, else the code.
 * Never the error's message, which names the path, and a path given as an
 * argument may be a secret typed where the text does not go.
 */
export function reasonOf(err: unknown): string {
	const code = errnoOf(err);
	if (code !== undefined) {
		return REASONS[code] ?? code;
	}
	return err instanceof Error ? err.message : String(err);
}
