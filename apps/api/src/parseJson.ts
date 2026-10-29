import type { z } from "zod";

/** JSON text checked against a schema: its value, or undefined if either fails. */
export function parseJson<S extends z.ZodType>(schema: S, text: string): z.output<S> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	const result = schema.safeParse(value);
	return result.success ? result.data : undefined;
}
