import { CliError, EXIT } from "./errors.js";
import { type CommandName, commandHelp, HELP, isCommand, VERSION } from "./help.js";
import { asksForHelp } from "./options.js";
import { writeLine } from "./terminal.js";
import type { Io } from "./types.js";

export type { InputStream, Io, NotesClient, OutputStream, Terminal } from "./types.js";

type Command = (args: ReadonlyArray<string>, io: Io) => Promise<void>;

/**
 * The commands, loaded when they run: the help and the version need neither
 * the SDK nor libsodium.
 */
const COMMANDS: Record<CommandName, () => Promise<Command>> = {
	send: async () => (await import("./commands/send.js")).send,
	read: async () => (await import("./commands/read.js")).read,
	check: async () => (await import("./commands/check.js")).check,
	delete: async () => (await import("./commands/delete.js")).deleteNote,
};

function unknownCommand(): CliError {
	// Not repeated: a secret typed in the wrong place would end up in a log.
	return new CliError("unknown command: see secret --help", EXIT.usage);
}

async function dispatch(argv: ReadonlyArray<string>, io: Io): Promise<number> {
	const [name, ...args] = argv;
	if (name === undefined) {
		io.stderr.write(HELP);
		return EXIT.usage;
	}
	if (name === "--version") {
		io.stdout.write(`${VERSION}\n`);
		return EXIT.ok;
	}
	if (name === "--help" || name === "-h") {
		io.stdout.write(HELP);
		return EXIT.ok;
	}
	if (name === "help") {
		const [topic, ...rest] = args;
		if (rest.length > 0 || (topic !== undefined && !isCommand(topic))) {
			throw unknownCommand();
		}
		io.stdout.write(topic === undefined ? HELP : commandHelp(topic));
		return EXIT.ok;
	}
	if (!isCommand(name)) {
		throw unknownCommand();
	}
	if (asksForHelp(args)) {
		io.stdout.write(commandHelp(name));
		return EXIT.ok;
	}
	const command = await COMMANDS[name]();
	await command(args, io);
	return EXIT.ok;
}

/**
 * One line on stderr; an unexpected error's stack only with `SECRET_DEBUG=1`.
 * Once Ctrl-C is pressed, whatever failed in its wake is the interruption.
 */
function report(err: unknown, io: Io): number {
	if (io.signal.aborted) {
		writeLine(io.stderr, "secret: interrupted");
		return EXIT.interrupted;
	}
	if (err instanceof CliError) {
		writeLine(io.stderr, `secret: ${err.message}`);
		if (io.env["SECRET_DEBUG"] === "1" && err.cause !== undefined) {
			writeLine(io.stderr, stackOf(err.cause));
		}
		return err.exitCode;
	}
	if (io.env["SECRET_DEBUG"] === "1") {
		writeLine(io.stderr, `secret: unexpected error\n${stackOf(err)}`);
	} else {
		writeLine(io.stderr, "secret: unexpected error (SECRET_DEBUG=1 shows it)");
	}
	return EXIT.failure;
}

function stackOf(err: unknown): string {
	return err instanceof Error && err.stack !== undefined ? err.stack : String(err);
}

/**
 * Runs the command line on `argv`, without node and the script, and resolves
 * to its exit code. It never throws, and writes nothing but through `io`.
 */
export async function run(argv: ReadonlyArray<string>, io: Io): Promise<number> {
	try {
		return await dispatch(argv, io);
	} catch (err) {
		return report(err, io);
	}
}
