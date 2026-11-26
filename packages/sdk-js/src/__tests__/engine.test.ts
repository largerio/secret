import { beforeEach, describe, expect, test, vi } from "vitest";

const ID = "aBcDeFgHiJkL";
const KEY = `1.${"k".repeat(43)}`;

// The crypto as the client loads it: each load recorded, its initialisation
// and what a note created or read calls of it stubbed.
const { engine, imported } = vi.hoisted(() => ({
	imported: vi.fn(),
	engine: {
		ensureInit: vi.fn<() => Promise<void>>(),
		formatOfFragment: vi.fn(() => 1),
		assertFormat0Fragment: vi.fn(),
		assertFormat1Fragment: vi.fn(),
		format1BodyOf: vi.fn(() => ({ head: new Uint8Array(4), files: [], length: 4096 })),
		encryptNoteFormat1: vi.fn(() =>
			Promise.resolve({
				messages: [new Uint8Array([1])],
				envelope: "envelope",
				verifiers: { linkVerifier: "verifier" },
				keyFragment: "1.key",
			}),
		),
		toBase64: vi.fn(() => "AQ=="),
	},
}));

vi.mock("../http.js", () => ({
	checkNote: vi.fn(() => Promise.resolve({ exists: false })),
	deleteNote: vi.fn(() => Promise.resolve()),
	postJson: vi.fn(() => Promise.resolve({ id: ID, expiresAt: "2099", deleteToken: "token" })),
}));

/** The client module afresh, its crypto not loaded yet, and the requests it sends. */
async function load() {
	vi.resetModules();
	// Registered again, so that loading the crypto is recorded once per load.
	vi.doMock("../engine.js", () => {
		imported();
		return engine;
	});
	const { SecretClient } = await import("../client.js");
	const http = (await import("../http.js")) as unknown as Record<
		"checkNote" | "deleteNote" | "postJson",
		ReturnType<typeof vi.fn>
	>;
	return { SecretClient, http };
}

beforeEach(() => {
	vi.clearAllMocks();
	engine.ensureInit.mockReset().mockResolvedValue(undefined);
});

describe("the crypto, loaded on demand", () => {
	test("new SecretClient() checks and deletes a note, and builds its link, without it", async () => {
		const { SecretClient, http } = await load();
		const client = new SecretClient({ baseUrl: "https://example.com" });

		await expect(client.checkNote(ID)).resolves.toEqual({ exists: false });
		await client.deleteNote(ID, "token");
		expect(SecretClient.parseShareUrl(client.buildShareUrl(ID, KEY))).toEqual({
			id: ID,
			keyFragment: KEY,
		});

		expect(http.checkNote).toHaveBeenCalledOnce();
		expect(http.deleteNote).toHaveBeenCalledOnce();
		expect(imported).not.toHaveBeenCalled();
		expect(engine.ensureInit).not.toHaveBeenCalled();
	});

	test("is loaded by the first note created, initialised, and once for every client", async () => {
		const { SecretClient } = await load();
		const client = new SecretClient();

		await expect(client.createNote({ text: "hi" })).resolves.toMatchObject({ id: ID });
		await client.createNote({ text: "again" });
		await new SecretClient().createNote({ text: "elsewhere" });
		await SecretClient.create();

		expect(imported).toHaveBeenCalledOnce();
		expect(engine.ensureInit).toHaveBeenCalledOnce();
		expect(engine.encryptNoteFormat1).toHaveBeenCalledTimes(3);
	});

	test("SecretClient.create() loads it first, and a client it returns does not again", async () => {
		const { SecretClient } = await load();

		const client = await SecretClient.create({ baseUrl: "https://example.com" });
		expect(client).toBeInstanceOf(SecretClient);
		expect(imported).toHaveBeenCalledOnce();
		expect(engine.ensureInit).toHaveBeenCalledOnce();

		await client.createNote({ text: "hi" });
		expect(engine.ensureInit).toHaveBeenCalledOnce();
	});

	test("SecretClient.create() fails where the crypto does not start, and tries again", async () => {
		const { SecretClient } = await load();
		engine.ensureInit.mockRejectedValueOnce(new Error("no WebAssembly"));

		await expect(SecretClient.create()).rejects.toThrow("no WebAssembly");
		await expect(SecretClient.create()).resolves.toBeInstanceOf(SecretClient);
		expect(engine.ensureInit).toHaveBeenCalledTimes(2);
	});

	test("a note created or read sends nothing when it failed to load, and the next call loads it", async () => {
		const { SecretClient, http } = await load();
		const client = new SecretClient();
		engine.ensureInit
			.mockRejectedValueOnce(new Error("chunk did not load"))
			.mockRejectedValueOnce(new Error("chunk did not load"));

		await expect(client.createNote({ text: "hi" })).rejects.toThrow("chunk did not load");
		await expect(client.readNote(ID, KEY)).rejects.toThrow("chunk did not load");
		expect(http.postJson).not.toHaveBeenCalled();
		expect(http.checkNote).not.toHaveBeenCalled();

		await expect(client.createNote({ text: "hi" })).resolves.toMatchObject({ id: ID });
		expect(engine.ensureInit).toHaveBeenCalledTimes(3);
	});

	test("a link is checked by the crypto before anything is read", async () => {
		const { SecretClient, http } = await load();
		engine.assertFormat1Fragment.mockImplementationOnce(() => {
			throw new Error("Invalid key fragment");
		});

		await expect(
			new SecretClient().readNoteInto(ID, "1.short", { openFile: vi.fn() }),
		).rejects.toThrow("Invalid key fragment");
		expect(http.checkNote).not.toHaveBeenCalled();
	});
});
