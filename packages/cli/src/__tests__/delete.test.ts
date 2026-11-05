import { SecretApiError } from "@largerio/secret-sdk";
import { describe, expect, it } from "vitest";
import { EXIT } from "../errors.js";
import { CAP_TOKEN, DELETE_TOKEN, harness, LINK, NOTE_ID, ORIGIN } from "./harness.js";

describe("secret delete", () => {
	it("deletes the note with a proof of work", async () => {
		const { run, stdout, stderr, client, configs, pow } = harness();
		expect(await run("delete", LINK, "--token", DELETE_TOKEN)).toBe(EXIT.ok);
		expect(configs).toEqual([{ baseUrl: ORIGIN, fetch: expect.any(Function) }]);
		expect(pow).toHaveBeenCalledWith(ORIGIN, expect.anything());
		expect(client.deleteNote).toHaveBeenCalledWith(NOTE_ID, DELETE_TOKEN, CAP_TOKEN, {
			signal: expect.any(AbortSignal),
		});
		expect(stdout.text).toBe("");
		expect(stderr.text).toBe("The note is deleted.\n");
	});

	it("deletes it with the API key, without a proof of work", async () => {
		const { run, client, configs, pow } = harness({ env: { SECRET_API_KEY: "the-key" } });
		expect(await run("delete", LINK, "--token", DELETE_TOKEN)).toBe(EXIT.ok);
		expect(configs[0]).toMatchObject({ apiKey: "the-key" });
		expect(pow).not.toHaveBeenCalled();
		expect(client.deleteNote).toHaveBeenCalledWith(NOTE_ID, DELETE_TOKEN, undefined, {
			signal: expect.any(AbortSignal),
		});
	});

	it("prints its answer with --json, and nothing with --quiet", async () => {
		const json = harness();
		expect(await json.run("delete", LINK, "--token", DELETE_TOKEN, "--json")).toBe(EXIT.ok);
		expect(JSON.parse(json.stdout.text)).toEqual({ deleted: true });
		expect(json.stderr.text).toBe("");

		const quiet = harness();
		expect(await quiet.run("delete", LINK, "--token", DELETE_TOKEN, "-q")).toBe(EXIT.ok);
		expect(quiet.stderr.text).toBe("");
	});

	it.each([[[]], [["--token", " "]]])("needs the delete token: %j", async (args) => {
		const { run, stderr, client } = harness();
		expect(await run("delete", LINK, ...args)).toBe(EXIT.usage);
		expect(stderr.text).toBe(
			"secret: give the note's delete token: secret delete <link> --token <deleteToken>\n",
		);
		expect(client.checkNote).not.toHaveBeenCalled();
	});

	it("solves nothing for a note that is gone", async () => {
		const { run, client, pow } = harness();
		client.checkNote.mockResolvedValue({ exists: false });
		expect(await run("delete", LINK, "--token", DELETE_TOKEN)).toBe(EXIT.notFound);
		expect(pow).not.toHaveBeenCalled();
		expect(client.deleteNote).not.toHaveBeenCalled();
	});

	it.each([
		[
			new SecretApiError("Wrong", 403, { code: "wrong_delete_token" }),
			EXIT.refused,
			"wrong delete token",
		],
		[
			new SecretApiError("Note not found", 404, { code: "note_not_found" }),
			EXIT.notFound,
			"this note does not exist: it expired, was already read, or never existed",
		],
		[
			new SecretApiError("HTTP 404", 404),
			EXIT.notFound,
			"this note does not exist: it expired, was already read, or never existed",
		],
		[
			new SecretApiError("Unauthorized", 401, { code: "unauthorized" }),
			EXIT.refused,
			"the instance refused the write: set SECRET_API_KEY, or check it",
		],
	])("reports a refusal: %s", async (err, exitCode, message) => {
		const { run, stderr, client } = harness();
		client.deleteNote.mockRejectedValue(err);
		expect(await run("delete", LINK, "--token", DELETE_TOKEN)).toBe(exitCode);
		expect(stderr.text).toBe(`secret: ${message}\n`);
	});
});
