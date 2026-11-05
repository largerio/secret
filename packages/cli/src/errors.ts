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

/** A failure the command reports in its own words, then exits with `exitCode`. */
export class CliError extends Error {
	readonly exitCode: ExitCode;

	constructor(message: string, exitCode: ExitCode = EXIT.failure, options?: ErrorOptions) {
		super(message, options);
		this.name = "CliError";
		this.exitCode = exitCode;
	}
}
