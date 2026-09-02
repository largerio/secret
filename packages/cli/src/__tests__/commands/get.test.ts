import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "../../commands/get.js";
import { CliError, UsageError } from "../../errors.js";
import { createFakeIo, stubClient } from "../helpers.js";

const URL = "https://secret.example.com/note/noteId#k3y";
const INFO = {
	exists: true,
	hasPassword: false,
	fileCount: 0,
	expiresAt: "2026-09-03T00:00:00.000Z",
	maxReads: 1,
	chunked: false,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("get", () => {
	it("derives the instance from the URL and never needs a key", async () => {
		const { client, create } = stubClient();
		client.checkNote.mockResolvedValue(INFO);
		client.readNote.mockResolvedValue({ payload: { text: "hi" } });
		const io = createFakeIo();

		expect(await get({ url: URL, force: false }, io)).toBe(0);

		expect(create).toHaveBeenCalledWith({ baseUrl: "https://secret.example.com" });
		expect(client.checkNote).toHaveBeenCalledWith("noteId");
		expect(client.readNote).toHaveBeenCalledWith("noteId", "k3y", { chunked: false });
		expect(io.out).toEqual(["hi"]);
	});

	it("requires a key fragment", async () => {
		const { create } = stubClient();
		await expect(
			get({ url: "https://s.example/note/id", force: false }, createFakeIo()),
		).rejects.toThrow(UsageError);
		expect(create).not.toHaveBeenCalled();
	});

	it("stops before consuming a read when the note is gone", async () => {
		const { client } = stubClient();
		client.checkNote.mockResolvedValue({ exists: false });

		await expect(get({ url: URL, force: false }, createFakeIo())).rejects.toThrow(CliError);
		await expect(get({ url: URL, force: false }, createFakeIo())).rejects.toThrow(/Note not found/);
		expect(client.readNote).not.toHaveBeenCalled();
	});

	it("stops before consuming a read when a password is needed but missing", async () => {
		const { client } = stubClient();
		client.checkNote.mockResolvedValue({ ...INFO, hasPassword: true });

		await expect(get({ url: URL, force: false }, createFakeIo())).rejects.toThrow(
			/password-protected: pass --password/,
		);
		expect(client.readNote).not.toHaveBeenCalled();
	});

	it("passes the password and the chunked hint through", async () => {
		const { client } = stubClient();
		client.checkNote.mockResolvedValue({ ...INFO, hasPassword: true, chunked: true });
		client.readNote.mockResolvedValue({ payload: { text: "secret" } });

		await get({ url: URL, password: "pw", force: false }, createFakeIo());

		expect(client.readNote).toHaveBeenCalledWith("noteId", "k3y", {
			chunked: true,
			password: "pw",
		});
	});

	it("adds a newline for a terminal only when the text lacks one", async () => {
		const { client } = stubClient();
		client.checkNote.mockResolvedValue(INFO);
		client.readNote.mockResolvedValue({ payload: { text: "no newline" } });
		const tty = createFakeIo({ stdoutIsTTY: true });
		await get({ url: URL, force: false }, tty);
		expect(tty.out).toEqual(["no newline", "\n"]);

		client.readNote.mockResolvedValue({ payload: { text: "ends\n" } });
		const tty2 = createFakeIo({ stdoutIsTTY: true });
		await get({ url: URL, force: false }, tty2);
		expect(tty2.out).toEqual(["ends\n"]);

		client.readNote.mockResolvedValue({ payload: { text: "no newline" } });
		const pipe = createFakeIo({ stdoutIsTTY: false });
		await get({ url: URL, force: false }, pipe);
		expect(pipe.out).toEqual(["no newline"]);
	});

	it("saves files under safe names into the output directory", async () => {
		const { client } = stubClient();
		client.checkNote.mockResolvedValue({ ...INFO, fileCount: 2 });
		const a = new Uint8Array(2048);
		const b = new Uint8Array([1]);
		client.readNote.mockResolvedValue({
			payload: {
				text: "with files",
				files: [
					{ name: "../../evil.sh", type: "text/plain", size: 2048, data: a },
					{ name: "b.bin", type: "application/octet-stream", size: 1, data: b },
				],
			},
		});
		const io = createFakeIo();

		await get({ url: URL, outDir: "./dl", force: true }, io);

		expect(io.dirs).toEqual(["./dl"]);
		expect(io.written.get(join("dl", "evil.sh"))).toBe(a);
		expect(io.written.get(join("dl", "b.bin"))).toBe(b);
		expect(io.out).toEqual(["with files"]);
		expect(io.err).toEqual([
			`Saved ${join("dl", "evil.sh")} (2.0 KB)\n`,
			`Saved ${join("dl", "b.bin")} (1 B)\n`,
		]);
	});

	it("defaults to the current directory", async () => {
		const { client } = stubClient();
		client.checkNote.mockResolvedValue({ ...INFO, fileCount: 1 });
		client.readNote.mockResolvedValue({
			payload: {
				files: [{ name: "a.txt", type: "text/plain", size: 1, data: new Uint8Array([1]) }],
			},
		});
		const io = createFakeIo();

		await get({ url: URL, force: false }, io);

		expect(io.dirs).toEqual(["."]);
		expect(io.written.get("a.txt")).toEqual(new Uint8Array([1]));
		expect(io.out).toEqual([]);
	});

	it("never overwrites without --force: the read is already spent, so it numbers the name", async () => {
		const { client } = stubClient();
		client.checkNote.mockResolvedValue({ ...INFO, fileCount: 3 });
		const data = new Uint8Array([1]);
		client.readNote.mockResolvedValue({
			payload: {
				files: [
					{ name: "a.txt", type: "text/plain", size: 1, data },
					{ name: "Makefile", type: "application/octet-stream", size: 1, data },
					{ name: ".env", type: "application/octet-stream", size: 1, data },
				],
			},
		});
		const io = createFakeIo({ existing: ["a.txt", "a (1).txt", "Makefile"] });

		await get({ url: URL, force: false }, io);

		expect([...io.written.keys()]).toEqual(["a (2).txt", "Makefile (1)", ".env"]);
		expect(io.err).toEqual([
			"Saved a (2).txt (1 B)\n",
			"Saved Makefile (1) (1 B)\n",
			"Saved .env (1 B)\n",
		]);
	});

	it("overwrites with --force", async () => {
		const { client } = stubClient();
		client.checkNote.mockResolvedValue({ ...INFO, fileCount: 1 });
		client.readNote.mockResolvedValue({
			payload: {
				files: [{ name: "a.txt", type: "text/plain", size: 1, data: new Uint8Array([1]) }],
			},
		});
		const io = createFakeIo({ existing: ["a.txt"] });

		await get({ url: URL, force: true }, io);

		expect([...io.written.keys()]).toEqual(["a.txt"]);
	});

	it("uses an explicit server and key over the URL", async () => {
		const { client, create } = stubClient();
		client.checkNote.mockResolvedValue(INFO);
		client.readNote.mockResolvedValue({ payload: {} });

		await get(
			{ url: URL, server: "https://other.example", apiKey: "k", force: false },
			createFakeIo(),
		);

		expect(create).toHaveBeenCalledWith({ baseUrl: "https://other.example", apiKey: "k" });
	});
});
