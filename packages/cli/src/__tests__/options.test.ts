import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";
import { EXIT } from "../errors.js";
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
import { cliErrorOf } from "./harness.js";

/** The message of the usage error `attempt` throws. */
async function usageMessageOf(attempt: () => unknown): Promise<string> {
	const error = await cliErrorOf(attempt);
	expect(error.exitCode).toBe(EXIT.usage);
	return error.message;
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

	it("names an unknown option, without the hint that follows", async () => {
		expect(await usageMessageOf(() => parse(["--secret=hunter2"]))).toBe(
			"unknown option '--secret': see secret delete --help",
		);
	});

	it("keeps the first line of a refused value, never the value", async () => {
		expect(await usageMessageOf(() => parse(["--token", "--json"]))).toBe(
			"option '--token' argument is ambiguous: see secret delete --help",
		);
		expect(await usageMessageOf(() => parse(["--json=hunter2"]))).toBe(
			"option '--json' does not take an argument: see secret delete --help",
		);
		expect(await usageMessageOf(() => parse(["--token"]))).toBe(
			"option '--token <value>' argument missing: see secret delete --help",
		);
	});

	it("reports what is not an Error as it is", async () => {
		expect(
			await usageMessageOf(() =>
				parsing("check", () => {
					throw "Broken";
				}),
			),
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

	it("asks for the link, without repeating what was given", async () => {
		expect(await usageMessageOf(() => linkArgument([], "read"))).toBe(
			"give the link of the note: secret read <link>",
		);
		const message = await usageMessageOf(() => linkArgument(["one#key", "two#key"], "check"));
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

	it.each(["1001", "-1", "1.5", "two", ""])("refuses %j", async (value) => {
		expect(await usageMessageOf(() => countOption(value, "--max-reads", 1, 1000))).toBe(
			"--max-reads takes a whole number from 0 to 1000",
		);
	});
});

describe("durationOption", () => {
	const expires = (value: string | undefined) => durationOption(value, "--expires", 300, 2_592_000);

	it("takes a duration within its bounds", () => {
		expect(expires(undefined)).toBeUndefined();
		expect(expires("5m")).toBe(300);
		expect(expires("30d")).toBe(2_592_000);
	});

	it("refuses what is no duration", async () => {
		expect(await usageMessageOf(() => expires("soon"))).toBe(
			"--expires takes a duration: 30m, 1h, 7d, 2w, or seconds",
		);
	});

	it.each(["90s", "299", "2592001", "31d", "5w"])(
		"refuses %s, outside 5m to 30d",
		async (value) => {
			expect(await usageMessageOf(() => expires(value))).toBe(
				"--expires takes a duration from 5m to 30d",
			);
		},
	);
});

describe("choiceOption", () => {
	it("takes one of the choices", () => {
		expect(choiceOption(undefined, "--mode", ["text", "markdown"])).toBeUndefined();
		expect(choiceOption("markdown", "--mode", ["text", "markdown"])).toBe("markdown");
	});

	it("names the choices", async () => {
		expect(await usageMessageOf(() => choiceOption("html", "--mode", ["text", "markdown"]))).toBe(
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
