import {
	type ExistingNoteInfo,
	type NoteInfo,
	SecretApiError,
	SecretDecryptionError,
	SecretNetworkError,
	SecretValidationError,
} from "@largerio/secret-sdk";
import { describe, expect, it, vi } from "vitest";
import { checkFailure, checkNoteLink, NOTICES, summarize } from "../check.js";
import { checkNote } from "../notes.js";

// No worker is started: the checks are handed in, or this one stands for it.
vi.mock("../notes.js", () => ({ checkNote: vi.fn() }));

const FORMAT_1: ExistingNoteInfo = {
	exists: true,
	hasPassword: true,
	fileCount: 2,
	expiresAt: "2026-11-07T12:00:00.000Z",
	maxReads: 3,
	readCount: 1,
	chunked: true,
	envelope: "AQID",
	passwordAttemptsLeft: 4,
};

/** A check that answers `info`. */
function answering(info: NoteInfo) {
	return vi.fn(async (_id: string) => info);
}

/** A check that fails with `error`. */
function failing(error: unknown) {
	return vi.fn(async (_id: string): Promise<NoteInfo> => {
		throw error;
	});
}

describe("summarize", () => {
	it("keeps what the page shows of a format 1 note", () => {
		expect(summarize(FORMAT_1)).toEqual({
			hasPassword: true,
			maxReads: 3,
			readCount: 1,
			fileCount: 2,
			expiresAt: "2026-11-07T12:00:00.000Z",
			chunked: true,
			format: 1,
			passwordAttemptsLeft: 4,
		});
	});

	it("tells a format 0 note by its missing envelope, and fills what an older API leaves out", () => {
		const format0: ExistingNoteInfo = {
			exists: true,
			hasPassword: false,
			fileCount: 0,
			expiresAt: "2026-11-07T12:00:00.000Z",
			maxReads: 1,
			chunked: false,
		};
		expect(summarize(format0)).toMatchObject({
			format: 0,
			readCount: null,
			passwordAttemptsLeft: null,
		});
	});
});

describe("checkFailure", () => {
	it("tells the visitor's own rate limit from an outage", () => {
		expect(checkFailure(new SecretApiError("Too many requests", 429))).toBe("rate_limited");
	});

	it("never calls an outage a missing note", () => {
		// "Note not found" during an outage told readers their secret was gone.
		expect(checkFailure(new SecretNetworkError("Network request failed"))).toBe("unavailable");
		expect(checkFailure(new SecretApiError("Timeout", 0))).toBe("unavailable");
		expect(checkFailure(new SecretApiError("Bad gateway", 502))).toBe("unavailable");
		expect(checkFailure(new SecretApiError("Forbidden", 403))).toBe("unavailable");
		expect(checkFailure(new Error("The worker did not start"))).toBe("unavailable");
	});

	it("calls an id the instance cannot have given a missing note", () => {
		expect(checkFailure(new SecretValidationError("Invalid note id"))).toBe("not_found");
	});

	it("does not mistake another error of the SDK's for one", () => {
		expect(checkFailure(new SecretDecryptionError("Decryption failed"))).toBe("unavailable");
	});
});

describe("checkNoteLink", () => {
	it("finds a note that is there", async () => {
		const check = answering(FORMAT_1);
		await expect(checkNoteLink("abc", check)).resolves.toEqual({
			kind: "found",
			note: summarize(FORMAT_1),
		});
		expect(check).toHaveBeenCalledWith("abc");
	});

	it("reports a note that is gone", async () => {
		await expect(checkNoteLink("abc", answering({ exists: false }))).resolves.toEqual({
			kind: "notice",
			notice: "not_found",
		});
	});

	it("reports why a check failed", async () => {
		await expect(
			checkNoteLink("abc", failing(new SecretApiError("Too many requests", 429))),
		).resolves.toEqual({ kind: "notice", notice: "rate_limited" });
		await expect(checkNoteLink("abc", failing(new SecretNetworkError("down")))).resolves.toEqual({
			kind: "notice",
			notice: "unavailable",
		});
	});

	it("never tells the creator a note is gone when the instance cannot be asked", async () => {
		// A creator come to revoke a leaked link would leave it readable.
		for (const error of [
			new SecretNetworkError("down"),
			new SecretApiError("Bad gateway", 502),
			new SecretApiError("Too many requests", 429),
		]) {
			const check = await checkNoteLink("abc", failing(error));
			expect(check).not.toEqual({ kind: "notice", notice: "not_found" });
		}
	});

	it("asks the notes' worker by default", async () => {
		vi.mocked(checkNote).mockResolvedValueOnce({ exists: false });
		await expect(checkNoteLink("abc")).resolves.toEqual({ kind: "notice", notice: "not_found" });
		expect(checkNote).toHaveBeenCalledWith("abc");
	});
});

describe("NOTICES", () => {
	it("gives every notice its own title and text: an outage never reads as a missing note", () => {
		const notices = Object.values(NOTICES);
		expect(new Set(notices.map((notice) => notice.title)).size).toBe(notices.length);
		expect(new Set(notices.map((notice) => notice.body)).size).toBe(notices.length);
	});
});
