import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "../errors.js";
import {
	asksForHelp,
	COMMON_OPTIONS,
	choiceOption,
	countOption,
	durationOption,
	linkArgument,
	lowerFirst,
	parsing,
} from "../options.js";

function usageError(run: () => unknown): CliError {
	try {
		run();
	} catch (err) {
		expect(err).toBeInstanceOf(CliError);
		expect((err as CliError).exitCode).toBe(EXIT.usage);
		return err as CliError;
	}
	throw new Error("no error");
}

const OPTIONS = { ...COMMON_OPTIONS, token: { type: "string" } } as const;

function parse(args: string[]) {
	return parsing("delete", () => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
}

describe("parsing", () => {
	it("returns what parseArgs parses", () => {
		expect(parse(["--json", "-q", "link"])).toMatchObject({
			values: { json: true, quiet: true },
			positionals: ["link"],
		});
	});

	it("names an unknown option, without the hint that follows", () => {
		expect(usageError(() => parse(["--secret=hunter2"])).message).toBe(
			"unknown option '--secret': see secret delete --help",
		);
	});

	it("keeps the first line of a refused value, never the value", () => {
		expect(usageError(() => parse(["--token", "--json"])).message).toBe(
			"option '--token' argument is ambiguous: see secret delete --help",
		);
		expect(usageError(() => parse(["--json=hunter2"])).message).toBe(
			"option '--json' does not take an argument: see secret delete --help",
		);
		expect(usageError(() => parse(["--token"])).message).toBe(
			"option '--token <value>' argument missing: see secret delete --help",
		);
	});

	it("reports what is not an Error as it is", () => {
		expect(
			usageError(() =>
				parsing("check", () => {
					throw "Broken";
				}),
			).message,
		).toBe("broken: see secret check --help");
	});
});

describe("asksForHelp", () => {
	it("finds -h or --help among the options", () => {
		expect(asksForHelp(["link", "--help"])).toBe(true);
		expect(asksForHelp(["-h"])).toBe(true);
		expect(asksForHelp(["--json"])).toBe(false);
	});

	it("stops at --, after which a file may be named --help", () => {
		expect(asksForHelp(["--", "--help"])).toBe(false);
	});
});

describe("linkArgument", () => {
	it("takes one link", () => {
		expect(linkArgument(["https://x/note/abc#k"], "read")).toBe("https://x/note/abc#k");
	});

	it("asks for the link, without repeating what was given", () => {
		expect(usageError(() => linkArgument([], "read")).message).toBe(
			"give the link of the note: secret read <link>",
		);
		const message = usageError(() => linkArgument(["one#key", "two#key"], "check")).message;
		expect(message).toBe("give one link: secret check <link>");
		expect(message).not.toContain("key");
	});
});

describe("countOption", () => {
	it("takes a whole number up to the maximum, or the default", () => {
		expect(countOption(undefined, "--max-reads", 1, 1000)).toBe(1);
		expect(countOption("0", "--max-reads", 1, 1000)).toBe(0);
		expect(countOption("1000", "--max-reads", 1, 1000)).toBe(1000);
	});

	it.each(["1001", "-1", "1.5", "two", ""])("refuses %j", (value) => {
		expect(usageError(() => countOption(value, "--max-reads", 1, 1000)).message).toBe(
			"--max-reads takes a whole number from 0 to 1000",
		);
	});
});

describe("durationOption", () => {
	it("takes a duration within the protocol's", () => {
		expect(durationOption(undefined, "--expires")).toBeUndefined();
		expect(durationOption("5m", "--expires")).toBe(300);
		expect(durationOption("30d", "--expires")).toBe(2_592_000);
	});

	it("refuses what is no duration", () => {
		expect(usageError(() => durationOption("soon", "--expires")).message).toBe(
			"--expires takes a duration: 30m, 1h, 7d, 2w, or seconds",
		);
	});

	it.each(["90s", "31d", "5w"])("refuses %s, outside 5m to 30d", (value) => {
		expect(usageError(() => durationOption(value, "--expires")).message).toBe(
			"--expires takes a duration from 5m to 30d",
		);
	});
});

describe("choiceOption", () => {
	it("takes one of the choices", () => {
		expect(choiceOption(undefined, "--mode", ["text", "markdown"])).toBeUndefined();
		expect(choiceOption("markdown", "--mode", ["text", "markdown"])).toBe("markdown");
	});

	it("names the choices", () => {
		expect(usageError(() => choiceOption("html", "--mode", ["text", "markdown"])).message).toBe(
			"--mode takes text, markdown",
		);
	});
});

describe("lowerFirst", () => {
	it("lowers the first letter only", () => {
		expect(lowerFirst("Invalid URL")).toBe("invalid URL");
		expect(lowerFirst("")).toBe("");
	});
});
