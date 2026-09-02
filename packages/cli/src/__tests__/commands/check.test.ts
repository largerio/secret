import { afterEach, describe, expect, it, vi } from "vitest";
import { check } from "../../commands/check.js";
import { createFakeIo, stubClient } from "../helpers.js";

const INFO = {
	exists: true,
	hasPassword: true,
	fileCount: 2,
	expiresAt: "2026-09-03T00:00:00.000Z",
	maxReads: 1,
	chunked: false,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("check", () => {
	it("prints the metadata of an existing note", async () => {
		const { client, create } = stubClient();
		client.checkNote.mockResolvedValue(INFO);
		const io = createFakeIo();

		expect(await check({ url: "https://s.example/note/id1", json: false }, io)).toBe(0);

		expect(create).toHaveBeenCalledWith({ baseUrl: "https://s.example" });
		expect(client.checkNote).toHaveBeenCalledWith("id1");
		expect(io.out.join("")).toBe(
			[
				"Status:    available",
				"Password:  required",
				"Files:     2",
				"Reads:     1 (burn after reading)",
				"Expires:   2026-09-03T00:00:00.000Z",
				"",
			].join("\n"),
		);
	});

	it("describes read limits", async () => {
		const { client } = stubClient();
		const env = { SECRET_SERVER_URL: "https://env.example" };

		client.checkNote.mockResolvedValue({ ...INFO, hasPassword: false, maxReads: 0 });
		const unlimited = createFakeIo({ env });
		await check({ url: "id1", json: false }, unlimited);
		expect(unlimited.out.join("")).toContain("Password:  none\n");
		expect(unlimited.out.join("")).toContain("Reads:     unlimited\n");

		client.checkNote.mockResolvedValue({ ...INFO, maxReads: 5 });
		const several = createFakeIo({ env });
		await check({ url: "id1", json: false }, several);
		expect(several.out.join("")).toContain("Reads:     up to 5\n");
	});

	it("exits 1 for a missing note", async () => {
		const { client } = stubClient();
		client.checkNote.mockResolvedValue({ exists: false });
		const io = createFakeIo();

		expect(await check({ url: "https://s.example/note/id1", json: false }, io)).toBe(1);

		expect(io.out).toEqual([]);
		expect(io.err).toEqual(["Note not found: it expired, was burned, or never existed\n"]);
	});

	it("prints the raw metadata with --json, keeping the exit code", async () => {
		const { client } = stubClient();
		client.checkNote.mockResolvedValue(INFO);
		const found = createFakeIo();
		expect(await check({ url: "https://s.example/note/id1", json: true }, found)).toBe(0);
		expect(JSON.parse(found.out.join(""))).toEqual(INFO);

		client.checkNote.mockResolvedValue({ exists: false });
		const missing = createFakeIo();
		expect(await check({ url: "https://s.example/note/id1", json: true }, missing)).toBe(1);
		expect(JSON.parse(missing.out.join(""))).toEqual({ exists: false });
		expect(missing.err).toEqual([]);
	});

	it("needs an instance when the URL carries none", async () => {
		stubClient();
		await expect(check({ url: "id1", json: false }, createFakeIo())).rejects.toThrow(
			/No Secret instance configured/,
		);
	});
});
