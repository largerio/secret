import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json" with { type: "json" };

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
	process.argv = originalArgv;
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.resetModules();
});

describe("bin entry", () => {
	it("runs the CLI against process.argv and sets the exit code", async () => {
		const written: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		process.argv = ["node", "secret", "--version"];

		await import("../cli.js");

		expect(written).toEqual([`${pkg.version}\n`]);
		expect(process.exitCode).toBe(0);
	});

	it("propagates a failing exit code", async () => {
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		process.argv = ["node", "secret", "nope"];

		await import("../cli.js");

		expect(written.join("")).toContain("Unknown command 'nope'");
		expect(process.exitCode).toBe(2);
	});
});
