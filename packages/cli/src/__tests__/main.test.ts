import {
	SecretApiError,
	SecretDecryptionError,
	SecretNetworkError,
	SecretValidationError,
} from "@largerio/secret-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { CliError, UsageError } from "../errors.js";
import { run } from "../main.js";
import { createFakeIo } from "./helpers.js";

vi.mock("../commands/send.js", () => ({ send: vi.fn() }));
vi.mock("../commands/get.js", () => ({ get: vi.fn() }));
vi.mock("../commands/check.js", () => ({ check: vi.fn() }));
vi.mock("../commands/delete.js", () => ({ deleteNote: vi.fn() }));

async function mocks() {
	const [send, get, check, del] = await Promise.all([
		import("../commands/send.js"),
		import("../commands/get.js"),
		import("../commands/check.js"),
		import("../commands/delete.js"),
	]);
	return {
		send: vi.mocked(send.send),
		get: vi.mocked(get.get),
		check: vi.mocked(check.check),
		deleteNote: vi.mocked(del.deleteNote),
	};
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("run", () => {
	it("prints help and version", async () => {
		const help = createFakeIo();
		expect(await run(["--help"], help)).toBe(0);
		expect(help.out.join("")).toMatch(/^Usage: secret <command>/);

		const sendHelp = createFakeIo();
		expect(await run(["send", "--help"], sendHelp)).toBe(0);
		expect(sendHelp.out.join("")).toMatch(/^Usage: secret send/);

		const version = createFakeIo();
		expect(await run(["--version"], version)).toBe(0);
		expect(version.out).toEqual([`${pkg.version}\n`]);
	});

	it("dispatches each command with its parsed arguments and returns its code", async () => {
		const m = await mocks();
		m.send.mockResolvedValue(0);
		m.get.mockResolvedValue(0);
		m.check.mockResolvedValue(1);
		m.deleteNote.mockResolvedValue(0);
		const io = createFakeIo();

		expect(await run(["send", "a.txt", "--burn"], io)).toBe(0);
		expect(m.send).toHaveBeenCalledWith({ files: ["a.txt"], maxReads: 1, json: false }, io);

		expect(await run(["get", "u", "-f"], io)).toBe(0);
		expect(m.get).toHaveBeenCalledWith({ url: "u", force: true }, io);

		expect(await run(["check", "u"], io)).toBe(1);
		expect(m.check).toHaveBeenCalledWith({ url: "u", json: false }, io);

		expect(await run(["delete", "u", "t"], io)).toBe(0);
		expect(m.deleteNote).toHaveBeenCalledWith({ url: "u", deleteToken: "t" }, io);
		expect(io.err).toEqual([]);
	});

	it("reports usage errors with a pointer to --help and exit code 2", async () => {
		const io = createFakeIo();
		expect(await run([], io)).toBe(2);
		expect(io.err).toEqual(["secret: No command given\nRun 'secret --help' for usage.\n"]);

		const m = await mocks();
		m.send.mockRejectedValue(new UsageError("Nothing to send"));
		const fromCommand = createFakeIo();
		expect(await run(["send"], fromCommand)).toBe(2);
		expect(fromCommand.err[0]).toMatch(/^secret: Nothing to send\n/);

		m.get.mockRejectedValue(new SecretValidationError("Invalid share URL"));
		const validation = createFakeIo();
		expect(await run(["get", "u"], validation)).toBe(2);
		expect(validation.err[0]).toMatch(/^secret: Invalid share URL\nRun 'secret --help'/);
	});

	it("reports API errors with their status, and a hint on 401", async () => {
		const m = await mocks();
		m.send.mockRejectedValue(new SecretApiError("Unauthorized", 401));
		const unauthorized = createFakeIo();
		expect(await run(["send"], unauthorized)).toBe(1);
		expect(unauthorized.err).toEqual([
			"secret: Unauthorized (HTTP 401)\nThe instance rejected the credentials: writes need a valid API key (--api-key or SECRET_API_KEY).\n",
		]);

		m.send.mockRejectedValue(new SecretApiError("Too many requests", 429));
		const limited = createFakeIo();
		expect(await run(["send"], limited)).toBe(1);
		expect(limited.err).toEqual(["secret: Too many requests (HTTP 429)\n"]);
	});

	it("reports network errors with their cause when there is one", async () => {
		const m = await mocks();
		m.check.mockRejectedValue(
			new SecretNetworkError("Network request failed", { cause: new Error("ECONNREFUSED") }),
		);
		const withCause = createFakeIo();
		expect(await run(["check", "u"], withCause)).toBe(1);
		expect(withCause.err).toEqual(["secret: Network request failed: ECONNREFUSED\n"]);

		m.check.mockRejectedValue(new SecretNetworkError("Network request failed", { cause: "?" }));
		const without = createFakeIo();
		expect(await run(["check", "u"], without)).toBe(1);
		expect(without.err).toEqual(["secret: Network request failed\n"]);
	});

	it("reports decryption and CLI errors as plain failures", async () => {
		const m = await mocks();
		m.get.mockRejectedValue(new SecretDecryptionError());
		const decryption = createFakeIo();
		expect(await run(["get", "u"], decryption)).toBe(1);
		expect(decryption.err).toEqual([
			"secret: Unable to decrypt: wrong password/key or corrupted data\n",
		]);

		m.get.mockRejectedValue(new CliError("Note not found"));
		const cli = createFakeIo();
		expect(await run(["get", "u"], cli)).toBe(1);
		expect(cli.err).toEqual(["secret: Note not found\n"]);
	});

	it("reports anything else by its message, or as a string", async () => {
		const m = await mocks();
		m.deleteNote.mockRejectedValue(new Error("ENOENT: no such file"));
		const error = createFakeIo();
		expect(await run(["delete", "u", "t"], error)).toBe(1);
		expect(error.err).toEqual(["secret: ENOENT: no such file\n"]);

		m.deleteNote.mockRejectedValue("weird");
		const thrown = createFakeIo();
		expect(await run(["delete", "u", "t"], thrown)).toBe(1);
		expect(thrown.err).toEqual(["secret: weird\n"]);
	});
});
