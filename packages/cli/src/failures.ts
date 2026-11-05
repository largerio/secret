import {
	SecretApiError,
	SecretDecryptionError,
	SecretNetworkError,
	SecretValidationError,
} from "@largerio/secret-sdk";
import { CliError, EXIT } from "./errors.js";
import type { Instance } from "./instance.js";
import { lowerFirst } from "./options.js";
import { formatDuration } from "./units.js";

export function notFound(): CliError {
	return new CliError(
		"this note does not exist: it expired, was already read, or never existed",
		EXIT.notFound,
	);
}

export const WRONG_PASSWORD_OR_LINK = "wrong password, or the link is wrong or damaged";

/**
 * What a failure is read against. An interruption needs none: once Ctrl-C is
 * pressed, `run` reports it, whatever failed in its wake.
 */
export interface FailureContext {
	readonly instance: Instance;
	/** A write, let in by an API key or by a proof of work; `format` is a note's being sent. */
	readonly write?: { readonly apiKey: boolean; readonly format?: 0 | 1 };
	/** Whether the requests name a note, so that a 404 is the note's. */
	readonly namesNote: boolean;
}

/**
 * A failure in the command's own words: one line that names neither the
 * link, nor a key, nor a password, and nothing the instance wrote either, a
 * code it names aside. What is no failure the command knows comes back as it
 * is, an unexpected error.
 */
export function failureOf(err: unknown, context: FailureContext): unknown {
	if (err instanceof CliError) {
		return err;
	}
	if (err instanceof SecretDecryptionError) {
		return new CliError(WRONG_PASSWORD_OR_LINK, EXIT.refused);
	}
	if (err instanceof SecretValidationError) {
		return new CliError(lowerFirst(err.message), EXIT.usage);
	}
	if (err instanceof SecretNetworkError) {
		return new CliError(`could not reach ${context.instance.origin}`, EXIT.failure, { cause: err });
	}
	if (err instanceof SecretApiError) {
		return apiFailure(err, context);
	}
	if (isSystemError(err)) {
		return new CliError(`${err.syscall} failed: ${err.code}`, EXIT.failure, { cause: err });
	}
	return err;
}

function isSystemError(err: unknown): err is NodeJS.ErrnoException & { syscall: string } {
	return err instanceof Error && typeof (err as NodeJS.ErrnoException).syscall === "string";
}

/** A code as the instance names it, if it looks like one: it is shown. */
function safeCode(code: string | undefined): string | undefined {
	return code !== undefined && /^[a-z0-9_]{1,64}$/.test(code) ? code : undefined;
}

/**
 * An instance's refusal, by its code (PROTOCOL.md, "Errors"), else by its
 * status: an answer without a code came from a proxy in front of the instance,
 * or from an instance older than 1.7.0.
 */
function apiFailure(err: SecretApiError, context: FailureContext): CliError {
	const { origin } = context.instance;
	const { write } = context;
	const fail = (message: string, exitCode: CliError["exitCode"] = EXIT.failure) =>
		new CliError(message, exitCode, { cause: err });

	switch (err.code) {
		case "note_not_found":
			return notFound();
		case "unauthorized":
			return unauthorized(context, err);
		case "rate_limited":
			return rateLimited(origin, err);
		case "wrong_delete_token":
			return fail("wrong delete token", EXIT.refused);
		case "wrong_link_proof":
		case "wrong_password":
			return fail(WRONG_PASSWORD_OR_LINK, EXIT.refused);
		case "note_format_mismatch":
			return fail("the link does not fit the note: it is wrong or damaged", EXIT.refused);
		case "expiry_above_limit":
			return fail(`${origin} keeps notes for less time than --expires asks`, EXIT.usage);
		case "too_many_files":
			return fail(`${origin} takes fewer files in a note`, EXIT.usage);
		case "too_many_chunks":
		case "payload_too_large":
		case "note_too_large":
			return fail(`the note is larger than ${origin} takes`);
		case "chunk_too_large":
			return fail(`${origin} refused a chunk of the note as too large`);
		case "storage_quota_exceeded":
			return fail(`the storage of ${origin} is full`);
		case "upload_not_found":
			return fail(`the upload expired before it was complete: send the note again`);
		case "bad_gateway":
			return fail(`the web server of ${origin} could not reach its API`);
	}

	if (err.code === undefined) {
		if (err.status === 0) {
			return fail(`${origin} did not answer in time`);
		}
		if (err.status === 401) {
			return unauthorized(context, err);
		}
		if (err.status === 429) {
			return rateLimited(origin, err);
		}
		if (err.status === 404 && context.namesNote) {
			return notFound();
		}
		if (err.status === 400 && write?.format === 1) {
			return fail(`${origin} refused the note: an instance older than 1.6.0 takes --format 0 only`);
		}
		if (err.status === 413) {
			return fail(`the note is larger than ${origin} takes`);
		}
	}

	const code = safeCode(err.code);
	const answer = code === undefined ? `HTTP ${err.status}` : `HTTP ${err.status}, ${code}`;
	if (err.status >= 500) {
		return fail(`${origin} failed (${answer})`);
	}
	return fail(
		`${origin} refused the request (${answer})`,
		err.status === 403 ? EXIT.refused : EXIT.failure,
	);
}

function unauthorized(context: FailureContext, err: SecretApiError): CliError {
	const message = context.write?.apiKey
		? "the instance refused the write: check SECRET_API_KEY"
		: "the instance refused the write: set SECRET_API_KEY, or check it";
	return new CliError(message, EXIT.refused, { cause: err });
}

function rateLimited(origin: string, err: SecretApiError): CliError {
	const wait =
		err.retryAfter === undefined ? "later" : `in ${formatDuration(Math.max(1, err.retryAfter))}`;
	return new CliError(
		`${origin} takes no more requests from this address for now: try again ${wait}`,
		EXIT.failure,
		{ cause: err },
	);
}
