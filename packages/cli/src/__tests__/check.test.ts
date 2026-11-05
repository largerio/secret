import { SecretNetworkError } from "@largerio/secret-sdk";
import { describe, expect, it } from "vitest";
import { EXIT } from "../errors.js";
import { EXPIRES_AT, existingNote, harness, LINK, NOTE_ID, ORIGIN, without } from "./harness.js";

const UNCOUNTED = without(existingNote({ maxReads: 3 }), "readCount");
const FORMAT_0 = without(existingNote({ hasPassword: true }), "passwordAttemptsLeft", "envelope");

describe("secret check", () => {
	it("shows what is known of the note, without reading it", async () => {
		const { run, stdout, client, configs } = harness();
		client.checkNote.mockResolvedValue(
			existingNote({ hasPassword: true, passwordAttemptsLeft: 4, fileCount: 2, maxReads: 3 }),
		);
		expect(await run("check", LINK, "--instance", "https://ignored.example")).toBe(EXIT.ok);
		expect(stdout.text).toBe(
			[
				"Password: yes, 4 wrong ones before the note is deleted",
				"Files:    2",
				`Expires:  ${EXPIRES_AT}`,
				"Reads:    3 left of 3",
				"Format:   1",
				"",
			].join("\n"),
		);
		expect(configs[0]).toMatchObject({ baseUrl: ORIGIN });
		expect(client.checkNote).toHaveBeenCalledWith(NOTE_ID, { signal: expect.any(AbortSignal) });
		expect(client.readNoteInto).not.toHaveBeenCalled();
	});

	it.each([
		[
			"no password, no limit",
			existingNote({ maxReads: 0 }),
			["Password: no", "Reads:    no limit"],
		],
		[
			"a last attempt",
			existingNote({ hasPassword: true, passwordAttemptsLeft: 1 }),
			["Password: yes, the next wrong one deletes the note"],
		],
		["an uncounted read", UNCOUNTED, ["Reads:    at most 3"]],
		["format 0", FORMAT_0, ["Password: yes", "Format:   0"]],
	])("shows %s", async (_name, info, lines) => {
		const { run, stdout, client } = harness();
		client.checkNote.mockResolvedValue(info);
		expect(await run("check", LINK)).toBe(EXIT.ok);
		for (const line of lines) {
			expect(stdout.text).toContain(`${line}\n`);
		}
	});

	it("makes what the instance answers safe on a terminal", async () => {
		const { run, stdout, client } = harness({ stdoutIsTTY: true });
		client.checkNote.mockResolvedValue(existingNote({ expiresAt: "\u001b[2Jsoon" }));
		expect(await run("check", LINK)).toBe(EXIT.ok);
		expect(stdout.text).toContain("Expires:  ␛[2Jsoon\n");
	});

	it("prints the SDK's answer with --json", async () => {
		const info = existingNote();
		const { run, stdout, client } = harness();
		client.checkNote.mockResolvedValue(info);
		expect(await run("check", LINK, "--json")).toBe(EXIT.ok);
		expect(JSON.parse(stdout.text)).toEqual(info);
	});

	it("exits with 3 for a note that is gone, its answer printed with --json", async () => {
		const human = harness();
		human.client.checkNote.mockResolvedValue({ exists: false });
		expect(await human.run("check", LINK)).toBe(EXIT.notFound);
		expect(human.stdout.text).toBe("");
		expect(human.stderr.text).toContain("this note does not exist");

		const json = harness();
		json.client.checkNote.mockResolvedValue({ exists: false });
		expect(await json.run("check", LINK, "--json")).toBe(EXIT.notFound);
		expect(JSON.parse(json.stdout.text)).toEqual({ exists: false });
	});

	it("names the instance it cannot reach", async () => {
		const { run, stderr, client } = harness();
		client.checkNote.mockRejectedValue(new SecretNetworkError("Network request failed"));
		expect(await run("check", LINK)).toBe(EXIT.failure);
		expect(stderr.text).toBe(`secret: could not reach ${ORIGIN}\n`);
	});

	it("refuses an unknown option", async () => {
		const { run, stderr } = harness();
		expect(await run("check", LINK, "--token", "x")).toBe(EXIT.usage);
		expect(stderr.text).toBe("secret: unknown option '--token': see secret check --help\n");
	});
});
