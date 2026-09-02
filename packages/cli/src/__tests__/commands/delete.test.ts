import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteNote } from "../../commands/delete.js";
import { UsageError } from "../../errors.js";
import { createFakeIo, stubClient } from "../helpers.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("delete", () => {
	it("deletes by id and token with the configured key", async () => {
		const { client, create } = stubClient();
		client.deleteNote.mockResolvedValue(undefined);
		const io = createFakeIo({ env: { SECRET_API_KEY: "k" } });

		expect(
			await deleteNote({ url: "https://s.example/note/id1#key", deleteToken: "tok" }, io),
		).toBe(0);

		expect(create).toHaveBeenCalledWith({ baseUrl: "https://s.example", apiKey: "k" });
		expect(client.deleteNote).toHaveBeenCalledWith("id1", "tok");
		expect(io.err).toEqual(["Note deleted.\n"]);
		expect(io.out).toEqual([]);
	});

	it("requires an API key", async () => {
		const { create } = stubClient();
		await expect(
			deleteNote({ url: "https://s.example/note/id1", deleteToken: "tok" }, createFakeIo()),
		).rejects.toThrow(UsageError);
		expect(create).not.toHaveBeenCalled();
	});

	it("relays the SDK's rejection", async () => {
		const { client } = stubClient();
		client.deleteNote.mockRejectedValue(new Error("boom"));
		await expect(
			deleteNote(
				{ url: "id1", deleteToken: "tok", server: "https://s.example", apiKey: "k" },
				createFakeIo(),
			),
		).rejects.toThrow("boom");
	});
});
