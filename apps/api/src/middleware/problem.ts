import { STATUS_CODES } from "node:http";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Every error the API answers is a problem details object (RFC 9457,
 * PROTOCOL.md "Errors"): `code` names it for clients, `detail` explains it to
 * a developer, and `error` repeats `detail` for clients written before codes.
 * A body without a code is not the API's: a proxy or a firewall in front of it.
 */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** The code of an error raised in no module's own terms: its status's. */
const CODE_OF_STATUS: Readonly<Partial<Record<number, string>>> = {
	400: "invalid_request",
	401: "unauthorized",
	404: "not_found",
	405: "method_not_allowed",
	413: "payload_too_large",
	415: "unsupported_media_type",
	429: "rate_limited",
	500: "internal_error",
};

export function codeOfStatus(status: number): string {
	return CODE_OF_STATUS[status] ?? (status >= 500 ? "internal_error" : "invalid_request");
}

/** An HTTPException that names its code, for the error handler to answer. */
export class ProblemException extends HTTPException {
	readonly code: string;

	constructor(
		status: ContentfulStatusCode,
		code: string,
		options: { readonly message: string; readonly cause?: unknown },
	) {
		super(status, options);
		this.code = code;
	}
}

/** The answer to an error: `extra` adds members, such as a 500's `errorId`. */
export function problem(
	c: Context,
	status: ContentfulStatusCode,
	code: string,
	detail: string,
	extra?: Readonly<Record<string, unknown>>,
): Response {
	const body = {
		type: "about:blank",
		title: STATUS_CODES[status],
		status,
		code,
		detail,
		error: detail,
		...extra,
	};
	return c.body(JSON.stringify(body), status, { "Content-Type": PROBLEM_CONTENT_TYPE });
}
