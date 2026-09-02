import { afterEach, describe, expect, it, vi } from "vitest";
import { send } from "../../commands/send.js";
import { UsageError } from "../../errors.js";
import { createFakeIo, stubClient } from "../helpers.js";

const ENV = { SECRET_SERVER_URL: "https://env.example", SECRET_API_KEY: "env-key" };
const RESULT = {
	id: "noteId",
	keyFragment: "k3y",
	deleteToken: "del-tok",
	expiresAt: "2026-09-03T00:00:00.000Z",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("send", () => {
	it("refuses to write without an API key, before touching stdin or files", async () => {
		const { create } = stubClient();
		const io = createFakeIo({ env: { SECRET_SERVER_URL: "https://env.example" } });
		await expect(send({ files: ["x"], json: false }, io)).rejects.toThrow(UsageError);
		await expect(send({ files: ["x"], json: false }, io)).rejects.toThrow(/needs an API key/);
		expect(create).not.toHaveBeenCalled();
	});

	it("needs a server too: a note URL cannot supply one here", async () => {
		const io = createFakeIo({ env: { SECRET_API_KEY: "k" } });
		await expect(send({ files: [], json: false }, io)).rejects.toThrow(/No Secret instance/);
	});

	it("rejects an empty invocation", async () => {
		const io = createFakeIo({ env: ENV, stdinIsTTY: true });
		await expect(send({ files: [], json: false }, io)).rejects.toThrow(/Nothing to send/);
	});

	it("treats empty piped stdin as nothing", async () => {
		const io = createFakeIo({ env: ENV, stdinIsTTY: false, stdin: "" });
		await expect(send({ files: [], json: false }, io)).rejects.toThrow(/Nothing to send/);
	});

	it("sends piped text with the SDK defaults and prints URL, token and expiry", async () => {
		const { client, create } = stubClient();
		client.createNote.mockResolvedValue(RESULT);
		const io = createFakeIo({ env: ENV, stdinIsTTY: false, stdin: "hello\n" });

		expect(await send({ files: [], json: false }, io)).toBe(0);

		expect(create).toHaveBeenCalledWith({ baseUrl: "https://env.example", apiKey: "env-key" });
		expect(client.createNote).toHaveBeenCalledWith({ text: "hello\n" });
		expect(io.out).toEqual(["https://secret.example.com/note/noteId#k3y\n"]);
		expect(io.err).toEqual(["Delete token: del-tok\nExpires: 2026-09-03T00:00:00.000Z\n"]);
	});

	it("prefers --text over stdin and forwards every option", async () => {
		const { client, create } = stubClient();
		client.createNote.mockResolvedValue(RESULT);
		const io = createFakeIo({ env: ENV, stdinIsTTY: false, stdin: "ignored" });

		await send(
			{
				files: [],
				text: "from flag",
				password: "pw",
				expiresIn: 300,
				maxReads: 0,
				server: "https://flag.example/",
				apiKey: "flag-key",
				json: false,
			},
			io,
		);

		expect(create).toHaveBeenCalledWith({ baseUrl: "https://flag.example", apiKey: "flag-key" });
		expect(client.createNote).toHaveBeenCalledWith({
			text: "from flag",
			password: "pw",
			expiresIn: 300,
			maxReads: 0,
		});
	});

	it("attaches files by basename with a guessed content type, plus stdin text", async () => {
		const { client } = stubClient();
		client.createNote.mockResolvedValue(RESULT);
		const pdf = new Uint8Array([1, 2]);
		const bin = new Uint8Array([3]);
		const io = createFakeIo({
			env: ENV,
			stdinIsTTY: false,
			stdin: "see attached",
			files: { "./docs/report.pdf": pdf, blob: bin },
		});

		await send({ files: ["./docs/report.pdf", "blob"], json: false }, io);

		expect(client.createNote).toHaveBeenCalledWith({
			text: "see attached",
			files: [
				{ name: "report.pdf", type: "application/pdf", data: pdf },
				{ name: "blob", type: "application/octet-stream", data: bin },
			],
		});
	});

	it("sends files alone when stdin is a terminal", async () => {
		const { client } = stubClient();
		client.createNote.mockResolvedValue(RESULT);
		const io = createFakeIo({ env: ENV, files: { "a.txt": new Uint8Array([65]) } });

		await send({ files: ["a.txt"], json: false }, io);

		expect(client.createNote).toHaveBeenCalledWith({
			files: [{ name: "a.txt", type: "text/plain", data: new Uint8Array([65]) }],
		});
	});

	it("relays a missing file", async () => {
		stubClient();
		const io = createFakeIo({ env: ENV });
		await expect(send({ files: ["nope.txt"], json: false }, io)).rejects.toThrow(/ENOENT/);
	});

	it("prints a single JSON object with --json", async () => {
		const { client } = stubClient();
		client.createNote.mockResolvedValue(RESULT);
		const io = createFakeIo({ env: ENV });

		expect(await send({ files: [], text: "x", json: true }, io)).toBe(0);

		expect(io.err).toEqual([]);
		expect(io.out).toHaveLength(1);
		expect(JSON.parse(io.out[0] ?? "")).toEqual({
			url: "https://secret.example.com/note/noteId#k3y",
			id: "noteId",
			deleteToken: "del-tok",
			expiresAt: "2026-09-03T00:00:00.000Z",
		});
	});
});
