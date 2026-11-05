import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "../errors.js";
import { HELP } from "../help.js";
import { harness, LINK } from "./harness.js";

const { version } = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("run", () => {
	it("prints the version of the package", async () => {
		const { run, stdout } = harness();
		expect(await run("--version")).toBe(EXIT.ok);
		expect(stdout.text).toBe(`${version}\n`);
	});

	it.each([["--help"], ["-h"], ["help"]])("prints the help on stdout for %s", async (arg) => {
		const { run, stdout, stderr } = harness();
		expect(await run(arg)).toBe(EXIT.ok);
		expect(stdout.text).toBe(HELP);
		expect(stderr.text).toBe("");
	});

	it("prints the help on stderr, as a wrong usage, without a command", async () => {
		const { run, stdout, stderr } = harness();
		expect(await run()).toBe(EXIT.usage);
		expect(stdout.text).toBe("");
		expect(stderr.text).toBe(HELP);
	});

	it.each([
		["help", "send"],
		["send", "--help"],
		["read", LINK, "-h"],
		["check", "--json", "--help"],
		["delete", "--help"],
	])("prints the help of a command: %s %s", async (...argv) => {
		const { run, stdout, client } = harness();
		expect(await run(...argv)).toBe(EXIT.ok);
		expect(stdout.text).toMatch(/^Usage: secret (send|read|check|delete) /);
		expect(client.checkNote).not.toHaveBeenCalled();
	});

	it("refuses an unknown command without repeating it", async () => {
		const { run, stderr } = harness();
		expect(await run("hunter2")).toBe(EXIT.usage);
		expect(stderr.text).toBe("secret: unknown command: see secret --help\n");
	});

	it.each([
		["help", "hunter2"],
		["help", "send", "read"],
	])("refuses the help of an unknown command: %s %s", async (...argv) => {
		const { run, stderr } = harness();
		expect(await run(...argv)).toBe(EXIT.usage);
		expect(stderr.text).toBe("secret: unknown command: see secret --help\n");
	});

	it("reports a failure in one line, made safe on a terminal", async () => {
		const { run, client, stderr } = harness({ stderrIsTTY: true });
		client.checkNote.mockRejectedValue(new CliError("bad \u001b[2J thing", EXIT.refused));
		expect(await run("check", LINK)).toBe(EXIT.refused);
		expect(stderr.text).toBe("secret: bad ␛[2J thing\n");
	});

	it("shows the cause of a failure with SECRET_DEBUG=1", async () => {
		const { run, client, stderr } = harness({ env: { SECRET_DEBUG: "1" } });
		const cause = new Error("the cause");
		client.checkNote.mockRejectedValue(new CliError("failed", EXIT.failure, { cause }));
		expect(await run("check", LINK)).toBe(EXIT.failure);
		expect(stderr.text).toContain("secret: failed\nError: the cause\n    at ");
	});

	it("shows no cause without SECRET_DEBUG, nor one that is not there", async () => {
		const quiet = harness();
		quiet.client.checkNote.mockRejectedValue(
			new CliError("failed", EXIT.failure, { cause: new Error("the cause") }),
		);
		await quiet.run("check", LINK);
		expect(quiet.stderr.text).toBe("secret: failed\n");

		const debug = harness({ env: { SECRET_DEBUG: "1" } });
		debug.client.checkNote.mockRejectedValue(new CliError("failed"));
		await debug.run("check", LINK);
		expect(debug.stderr.text).toBe("secret: failed\n");
	});

	it("reports an unexpected error without its details", async () => {
		const { run, client, stderr } = harness();
		client.checkNote.mockRejectedValue(new TypeError("undefined is not a function"));
		expect(await run("check", LINK)).toBe(EXIT.failure);
		expect(stderr.text).toBe("secret: unexpected error (SECRET_DEBUG=1 shows it)\n");
	});

	it("shows an unexpected error with SECRET_DEBUG=1", async () => {
		const { run, client, stderr } = harness({ env: { SECRET_DEBUG: "1" } });
		client.checkNote.mockRejectedValue(new TypeError("undefined is not a function"));
		expect(await run("check", LINK)).toBe(EXIT.failure);
		expect(stderr.text).toContain(
			"secret: unexpected error\nTypeError: undefined is not a function\n    at ",
		);

		const thrown = harness({ env: { SECRET_DEBUG: "1" } });
		thrown.client.checkNote.mockRejectedValue("a string");
		await thrown.run("check", LINK);
		expect(thrown.stderr.text).toBe("secret: unexpected error\na string\n");
	});

	it.each([
		["the abort's reason", () => new DOMException("This operation was aborted", "AbortError")],
		["a failure in its wake", () => new CliError("could not reach the instance")],
	])("reports an interruption, whatever was thrown: %s", async (_name, thrown) => {
		const controller = new AbortController();
		const { run, client, stderr } = harness({ signal: controller.signal });
		client.checkNote.mockImplementation(async () => {
			controller.abort();
			throw thrown();
		});
		expect(await run("check", LINK)).toBe(EXIT.interrupted);
		expect(stderr.text).toBe("secret: interrupted\n");
	});
});
