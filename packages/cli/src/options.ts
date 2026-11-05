import type { ParseArgsOptionsConfig } from "node:util";
import { CliError, EXIT } from "./errors.js";
import type { CommandName } from "./help.js";
import { formatDuration, parseDuration } from "./units.js";

/**
 * The options every command takes. `--instance` is the one of `send`: a link
 * names its own instance, so the other commands take it and ignore it.
 */
export const COMMON_OPTIONS = {
	help: { type: "boolean", short: "h" },
	json: { type: "boolean" },
	quiet: { type: "boolean", short: "q" },
	instance: { type: "string" },
} as const satisfies ParseArgsOptionsConfig;

/** Whether the arguments ask for the command's help, `--` ending the options. */
export function asksForHelp(args: ReadonlyArray<string>): boolean {
	for (const arg of args) {
		if (arg === "--") {
			return false;
		}
		if (arg === "--help" || arg === "-h") {
			return true;
		}
	}
	return false;
}

/**
 * Runs `parseArgs`, its refusal becoming a usage error. Its messages name the
 * option, never a value: an option's value may be a secret.
 */
export function parsing<T>(command: CommandName, parse: () => T): T {
	try {
		return parse();
	} catch (err) {
		throw new CliError(`${usageMessageOf(err)}: see secret ${command} --help`, EXIT.usage);
	}
}

function usageMessageOf(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	// The first sentence: an unknown option is followed by a hint about
	// positionals, an ambiguous one by lines of hints.
	const end = message.search(/\.( |\n|$)/);
	return lowerFirst(end === -1 ? message : message.slice(0, end));
}

export function lowerFirst(text: string): string {
	return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The one link a command takes, never repeated in a message: it holds a key. */
export function linkArgument(positionals: ReadonlyArray<string>, command: CommandName): string {
	const [link, ...rest] = positionals;
	if (link === undefined) {
		throw new CliError(`give the link of the note: secret ${command} <link>`, EXIT.usage);
	}
	if (rest.length > 0) {
		throw new CliError(`give one link: secret ${command} <link>`, EXIT.usage);
	}
	return link;
}

/** A whole number from 0 to `max`, or `fallback` when the option is not given. */
export function countOption(
	value: string | undefined,
	name: string,
	fallback: number,
	max: number,
): number {
	if (value === undefined) {
		return fallback;
	}
	if (!/^\d{1,9}$/.test(value) || Number(value) > max) {
		throw new CliError(`${name} takes a whole number from 0 to ${max}`, EXIT.usage);
	}
	return Number(value);
}

/** A duration in seconds, from `min` to `max`; undefined when the option is not given. */
export function durationOption(
	value: string | undefined,
	name: string,
	min: number,
	max: number,
): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const seconds = parseDuration(value);
	if (seconds === undefined) {
		throw new CliError(`${name} takes a duration: 30m, 1h, 7d, 2w, or seconds`, EXIT.usage);
	}
	if (seconds < min || seconds > max) {
		throw new CliError(
			`${name} takes a duration from ${formatDuration(min)} to ${formatDuration(max)}`,
			EXIT.usage,
		);
	}
	return seconds;
}

/** One of `choices`, or undefined when the option is not given. */
export function choiceOption<T extends string>(
	value: string | undefined,
	name: string,
	choices: ReadonlyArray<T>,
): T | undefined {
	if (value === undefined) {
		return undefined;
	}
	const choice = choices.find((candidate) => candidate === value);
	if (choice === undefined) {
		throw new CliError(`${name} takes ${choices.join(", ")}`, EXIT.usage);
	}
	return choice;
}
