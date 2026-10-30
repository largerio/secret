import { STATUS_CODES } from "node:http";

/** The problem details the API answers an error with (PROTOCOL.md, "Errors"). */
export function problemOf(
	status: number,
	code: string,
	detail: string,
	extra?: Readonly<Record<string, unknown>>,
) {
	return {
		type: "about:blank",
		title: STATUS_CODES[status],
		status,
		code,
		detail,
		error: detail,
		...extra,
	};
}
