import {
	SecretApiError,
	SecretDecryptionError,
	SecretNetworkError,
	SecretValidationError,
} from "@largerio/secret-sdk";
import pkg from "../package.json" with { type: "json" };
import { parseArgv } from "./args.js";
import { check } from "./commands/check.js";
import { deleteNote } from "./commands/delete.js";
import { get } from "./commands/get.js";
import { send } from "./commands/send.js";
import { CliError, EXIT, errorMessage, UsageError } from "./errors.js";
import { usage } from "./help.js";
import type { Io } from "./io.js";

function describeError(err: unknown): { message: string; exitCode: number } {
	// A malformed share URL or an oversized payload: wrong input, not a failure.
	if (err instanceof UsageError || err instanceof SecretValidationError) {
		return { message: `${err.message}\nRun 'secret --help' for usage.`, exitCode: EXIT.usage };
	}
	if (err instanceof SecretApiError) {
		const hint =
			err.status === 401
				? "\nThe instance rejected the credentials: writes need a valid API key (--api-key or SECRET_API_KEY)."
				: "";
		return {
			message: `${err.message} (HTTP ${String(err.status)})${hint}`,
			exitCode: EXIT.failure,
		};
	}
	if (err instanceof SecretNetworkError) {
		const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
		return { message: `${err.message}${cause}`, exitCode: EXIT.failure };
	}
	if (err instanceof SecretDecryptionError || err instanceof CliError) {
		return { message: err.message, exitCode: EXIT.failure };
	}
	return { message: errorMessage(err), exitCode: EXIT.failure };
}

/**
 * Parse, dispatch, and turn every failure into a message on stderr plus an
 * exit code. Never throws: the entry point only has to forward the code.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
	try {
		const parsed = parseArgv(argv);
		switch (parsed.kind) {
			case "help":
				io.writeOut(usage(parsed.command));
				return EXIT.ok;
			case "version":
				io.writeOut(`${pkg.version}\n`);
				return EXIT.ok;
			case "send":
				return await send(parsed.args, io);
			case "get":
				return await get(parsed.args, io);
			case "check":
				return await check(parsed.args, io);
			case "delete":
				return await deleteNote(parsed.args, io);
		}
	} catch (err) {
		const { message, exitCode } = describeError(err);
		io.writeErr(`secret: ${message}\n`);
		return exitCode;
	}
}
