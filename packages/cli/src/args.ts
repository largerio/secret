import { type ParseArgsConfig, parseArgs } from "node:util";
import { errorMessage, UsageError } from "./errors.js";
import { parseDuration, parseReads } from "./format.js";

export const COMMANDS = ["send", "get", "check", "delete"] as const;
export type Command = (typeof COMMANDS)[number];

export interface ConnectionArgs {
	readonly server?: string;
	readonly apiKey?: string;
}

export interface SendArgs extends ConnectionArgs {
	readonly files: readonly string[];
	readonly text?: string;
	readonly password?: string;
	/** Seconds; undefined leaves the SDK default (24 h). */
	readonly expiresIn?: number;
	/** 0 = unlimited; undefined leaves the SDK default (burn after one read). */
	readonly maxReads?: number;
	readonly json: boolean;
}

export interface GetArgs extends ConnectionArgs {
	readonly url: string;
	readonly password?: string;
	readonly outDir?: string;
	readonly force: boolean;
}

export interface CheckArgs extends ConnectionArgs {
	readonly url: string;
	readonly json: boolean;
}

export interface DeleteArgs extends ConnectionArgs {
	readonly url: string;
	readonly deleteToken: string;
}

export type ParsedArgv =
	| { readonly kind: "help"; readonly command?: Command }
	| { readonly kind: "version" }
	| { readonly kind: "send"; readonly args: SendArgs }
	| { readonly kind: "get"; readonly args: GetArgs }
	| { readonly kind: "check"; readonly args: CheckArgs }
	| { readonly kind: "delete"; readonly args: DeleteArgs };

const CONNECTION_OPTIONS = {
	server: { type: "string", short: "s" },
	"api-key": { type: "string", short: "k" },
	help: { type: "boolean", short: "h" },
} as const;

function isCommand(value: string): value is Command {
	return (COMMANDS as readonly string[]).includes(value);
}

/**
 * `node:util`'s parser does the tokenising (short flags, `--opt=value`, `--`),
 * so the CLI carries no argument-parsing dependency. Its errors are already
 * worded for a person; they only need the usage exit code.
 */
function parseWith<const T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
	try {
		return parseArgs(config);
	} catch (err) {
		throw new UsageError(errorMessage(err));
	}
}

function connectionArgs(values: {
	readonly server?: string | undefined;
	readonly "api-key"?: string | undefined;
}): ConnectionArgs {
	return {
		...(values.server !== undefined ? { server: values.server } : {}),
		...(values["api-key"] !== undefined ? { apiKey: values["api-key"] } : {}),
	};
}

function expectPositionals(command: Command, positionals: string[], names: string[]): string[] {
	if (positionals.length < names.length) {
		const missing = names.slice(positionals.length).join("> <");
		throw new UsageError(`Missing argument for '${command}': <${missing}>`);
	}
	if (positionals.length > names.length) {
		const extra = positionals.slice(names.length).join(" ");
		throw new UsageError(`Unexpected argument for '${command}': '${extra}'`);
	}
	return positionals;
}

function parseSend(argv: string[]): ParsedArgv {
	const { values, positionals } = parseWith({
		args: argv,
		options: {
			...CONNECTION_OPTIONS,
			text: { type: "string", short: "t" },
			password: { type: "string", short: "p" },
			burn: { type: "boolean", short: "b" },
			expires: { type: "string", short: "e" },
			reads: { type: "string", short: "r" },
			json: { type: "boolean" },
		},
		allowPositionals: true,
		strict: true,
	});
	if (values.help === true) return { kind: "help", command: "send" };
	if (values.burn === true && values.reads !== undefined) {
		throw new UsageError("--burn and --reads are mutually exclusive (--burn means --reads 1)");
	}
	const maxReads =
		values.burn === true ? 1 : values.reads !== undefined ? parseReads(values.reads) : undefined;
	const expiresIn = values.expires !== undefined ? parseDuration(values.expires) : undefined;
	return {
		kind: "send",
		args: {
			...connectionArgs(values),
			files: positionals,
			...(values.text !== undefined ? { text: values.text } : {}),
			...(values.password !== undefined ? { password: values.password } : {}),
			...(expiresIn !== undefined ? { expiresIn } : {}),
			...(maxReads !== undefined ? { maxReads } : {}),
			json: values.json === true,
		},
	};
}

function parseGet(argv: string[]): ParsedArgv {
	const { values, positionals } = parseWith({
		args: argv,
		options: {
			...CONNECTION_OPTIONS,
			password: { type: "string", short: "p" },
			out: { type: "string", short: "o" },
			force: { type: "boolean", short: "f" },
		},
		allowPositionals: true,
		strict: true,
	});
	if (values.help === true) return { kind: "help", command: "get" };
	const [url = ""] = expectPositionals("get", positionals, ["url"]);
	return {
		kind: "get",
		args: {
			...connectionArgs(values),
			url,
			...(values.password !== undefined ? { password: values.password } : {}),
			...(values.out !== undefined ? { outDir: values.out } : {}),
			force: values.force === true,
		},
	};
}

function parseCheck(argv: string[]): ParsedArgv {
	const { values, positionals } = parseWith({
		args: argv,
		options: { ...CONNECTION_OPTIONS, json: { type: "boolean" } },
		allowPositionals: true,
		strict: true,
	});
	if (values.help === true) return { kind: "help", command: "check" };
	const [url = ""] = expectPositionals("check", positionals, ["url"]);
	return { kind: "check", args: { ...connectionArgs(values), url, json: values.json === true } };
}

function parseDelete(argv: string[]): ParsedArgv {
	const { values, positionals } = parseWith({
		args: argv,
		options: CONNECTION_OPTIONS,
		allowPositionals: true,
		strict: true,
	});
	if (values.help === true) return { kind: "help", command: "delete" };
	const [url = "", deleteToken = ""] = expectPositionals("delete", positionals, [
		"url",
		"deleteToken",
	]);
	return { kind: "delete", args: { ...connectionArgs(values), url, deleteToken } };
}

const PARSERS: Readonly<Record<Command, (argv: string[]) => ParsedArgv>> = {
	send: parseSend,
	get: parseGet,
	check: parseCheck,
	delete: parseDelete,
};

/** Turn `process.argv.slice(2)` into a command, or throw a {@link UsageError}. */
export function parseArgv(argv: readonly string[]): ParsedArgv {
	const [first, ...rest] = argv;
	if (first === undefined) {
		throw new UsageError("No command given");
	}
	if (first === "--help" || first === "-h" || first === "help") {
		const topic = rest[0];
		return topic !== undefined && isCommand(topic)
			? { kind: "help", command: topic }
			: { kind: "help" };
	}
	if (first === "--version" || first === "-V") {
		return { kind: "version" };
	}
	if (!isCommand(first)) {
		throw new UsageError(`Unknown command '${first}'`);
	}
	return PARSERS[first](rest);
}
