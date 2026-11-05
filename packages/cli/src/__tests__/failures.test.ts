import {
	SecretApiError,
	SecretDecryptionError,
	SecretNetworkError,
	SecretValidationError,
} from "@largerio/secret-sdk";
import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "../errors.js";
import { type FailureContext, translateError } from "../failures.js";
import { cliErrorOf, ORIGIN } from "./harness.js";

const instance = { baseUrl: ORIGIN, origin: ORIGIN };
const reading: FailureContext = { instance, namesNote: true };
const sending: FailureContext = {
	instance,
	write: { apiKey: false, format: 1 },
	namesNote: false,
};
const sendingWithKey: FailureContext = { ...sending, write: { apiKey: true, format: 1 } };
const sendingFormat0: FailureContext = { ...sending, write: { apiKey: false, format: 0 } };
const deleting: FailureContext = { instance, write: { apiKey: false }, namesNote: true };

/** The CliError a failure becomes in the command's words. */
function translated(err: unknown, context: FailureContext): Promise<CliError> {
	return cliErrorOf(() => translateError(err, context));
}

const NOT_FOUND = "this note does not exist: it expired, was already read, or never existed";

describe("translateError", () => {
	it("keeps the command's own failures", () => {
		const own = new CliError("own");
		expect(translateError(own, reading)).toBe(own);
	});

	it("tells a failed decryption apart from nothing else", async () => {
		expect(await translated(new SecretDecryptionError(), reading)).toMatchObject({
			message: "wrong password, or the link is wrong or damaged",
			exitCode: EXIT.refused,
		});
	});

	it("passes on the SDK's word for what it refused before doing anything", async () => {
		expect(
			await translated(new SecretValidationError("A note can include at most 10 files"), sending),
		).toMatchObject({ message: "a note can include at most 10 files", exitCode: EXIT.usage });
	});

	it("names the instance it cannot reach", async () => {
		expect(
			await translated(new SecretNetworkError("Network request failed"), reading),
		).toMatchObject({
			message: `could not reach ${ORIGIN}`,
			exitCode: EXIT.failure,
		});
	});

	it("names the failed system call", async () => {
		const err = Object.assign(new Error("ENOSPC: no space left"), {
			code: "ENOSPC",
			syscall: "write",
		});
		expect(await translated(err, reading)).toMatchObject({
			message: "write failed: the disk is full",
			exitCode: EXIT.failure,
		});
	});

	it("leaves an unexpected failure as it is", () => {
		const err = new TypeError("undefined is not a function");
		expect(translateError(err, reading)).toBe(err);
		expect(translateError("thrown", reading)).toBe("thrown");
	});
});

describe("translateError of an instance's refusal", () => {
	const api = (status: number, code?: string, retryAfter?: number) =>
		new SecretApiError("Something the instance says\u001b[2J", status, { code, retryAfter });

	it.each<[string, SecretApiError, FailureContext, string, number]>([
		["note_not_found", api(404, "note_not_found"), reading, NOT_FOUND, EXIT.notFound],
		[
			"unauthorized, without a key",
			api(401, "unauthorized"),
			sending,
			"the instance refused the write: set SECRET_API_KEY, or check it",
			EXIT.refused,
		],
		[
			"unauthorized, with a key",
			api(401, "unauthorized"),
			sendingWithKey,
			"the instance refused the write: check SECRET_API_KEY",
			EXIT.refused,
		],
		[
			"rate_limited",
			api(429, "rate_limited", 90),
			sending,
			`${ORIGIN} takes no more requests from this address for now: try again in 1m 30s`,
			EXIT.failure,
		],
		[
			"rate_limited, without a wait",
			api(429, "rate_limited"),
			sending,
			`${ORIGIN} takes no more requests from this address for now: try again later`,
			EXIT.failure,
		],
		[
			"rate_limited, at once",
			api(429, "rate_limited", 0),
			sending,
			`${ORIGIN} takes no more requests from this address for now: try again in 1s`,
			EXIT.failure,
		],
		["wrong_delete_token", api(403, "wrong_delete_token"), deleting, "wrong delete token", 4],
		[
			"wrong_link_proof",
			api(403, "wrong_link_proof"),
			reading,
			"wrong password, or the link is wrong or damaged",
			EXIT.refused,
		],
		[
			"wrong_password",
			api(403, "wrong_password"),
			reading,
			"wrong password, or the link is wrong or damaged",
			EXIT.refused,
		],
		[
			"note_format_mismatch",
			api(400, "note_format_mismatch"),
			reading,
			"the link does not fit the note: it is wrong or damaged",
			EXIT.refused,
		],
		[
			"expiry_above_limit",
			api(400, "expiry_above_limit"),
			sending,
			`${ORIGIN} keeps notes for less time than --expires asks`,
			EXIT.usage,
		],
		[
			"too_many_files",
			api(400, "too_many_files"),
			sending,
			`${ORIGIN} takes fewer files in a note`,
			EXIT.usage,
		],
		[
			"too_many_chunks",
			api(400, "too_many_chunks"),
			sending,
			`the note is larger than ${ORIGIN} takes`,
			EXIT.failure,
		],
		[
			"payload_too_large",
			api(413, "payload_too_large"),
			sending,
			`the note is larger than ${ORIGIN} takes`,
			EXIT.failure,
		],
		[
			"note_too_large",
			api(413, "note_too_large"),
			sending,
			`the note is larger than ${ORIGIN} takes`,
			EXIT.failure,
		],
		[
			"chunk_too_large",
			api(413, "chunk_too_large"),
			sending,
			`${ORIGIN} refused a chunk of the note as too large`,
			EXIT.failure,
		],
		[
			"storage_quota_exceeded",
			api(507, "storage_quota_exceeded"),
			sending,
			`the storage of ${ORIGIN} is full`,
			EXIT.failure,
		],
		[
			"upload_not_found",
			api(404, "upload_not_found"),
			sending,
			"the upload expired before it was complete: send the note again",
			EXIT.failure,
		],
		[
			"bad_gateway",
			api(502, "bad_gateway"),
			reading,
			`the web server of ${ORIGIN} could not reach its API`,
			EXIT.failure,
		],
		["a timeout", api(0), reading, `${ORIGIN} did not answer in time`, EXIT.failure],
		[
			"a 401 without a code",
			api(401),
			sending,
			"the instance refused the write: set SECRET_API_KEY, or check it",
			EXIT.refused,
		],
		[
			"a 429 without a code",
			api(429),
			sending,
			`${ORIGIN} takes no more requests from this address for now: try again later`,
			EXIT.failure,
		],
		["a 404 without a code, of a note", api(404), reading, NOT_FOUND, EXIT.notFound],
		[
			"a 404 without a code, of no note",
			api(404),
			sending,
			`${ORIGIN} refused the request (HTTP 404)`,
			EXIT.failure,
		],
		[
			"a 400 without a code, to a note of format 1",
			api(400),
			sending,
			`${ORIGIN} refused the note: an instance older than 1.6.0 takes --format 0 only`,
			EXIT.failure,
		],
		[
			"a 400 without a code, to a note of format 0",
			api(400),
			sendingFormat0,
			`${ORIGIN} refused the request (HTTP 400)`,
			EXIT.failure,
		],
		[
			"a 400 without a code, to no write",
			api(400),
			reading,
			`${ORIGIN} refused the request (HTTP 400)`,
			EXIT.failure,
		],
		[
			"a 413 without a code",
			api(413),
			sending,
			`the note is larger than ${ORIGIN} takes`,
			EXIT.failure,
		],
		[
			"a 500",
			api(500, "internal_error"),
			reading,
			`${ORIGIN} failed (HTTP 500, internal_error)`,
			1,
		],
		[
			"a 403 without a code",
			api(403),
			deleting,
			`${ORIGIN} refused the request (HTTP 403)`,
			EXIT.refused,
		],
		[
			"an unknown code",
			api(409, "chunk_in_flight"),
			sending,
			`${ORIGIN} refused the request (HTTP 409, chunk_in_flight)`,
			EXIT.failure,
		],
		[
			"a code that is no code",
			api(418, "\u001b]0;pwned\u0007"),
			sending,
			`${ORIGIN} refused the request (HTTP 418)`,
			EXIT.failure,
		],
	])("reads %s", async (_name, err, context, message, exitCode) => {
		const failure = await translated(err, context);
		expect(failure).toMatchObject({ message, exitCode });
		expect(failure.message).not.toContain("Something the instance says");
	});
});
