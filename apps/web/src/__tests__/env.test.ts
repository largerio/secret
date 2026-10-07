import { describe, expect, it } from "vitest";
import { variables } from "../env.js";

describe("declared environment variables", () => {
	it("are all optional, so an unconfigured instance still boots", () => {
		// A variable whose schema rejects `undefined` makes the server refuse to
		// start until it is set — the zero-config Docker image would crash-loop.
		for (const [name, config] of Object.entries(variables)) {
			expect(config.schema["~standard"].validate(undefined), name).toEqual({ value: undefined });
		}
	});

	it("pass a configured value through untouched", () => {
		// Parsing and defaults stay where each value is read (server-config.ts,
		// server/env.ts), so the schema must not reshape anything.
		for (const [name, config] of Object.entries(variables)) {
			expect(config.schema["~standard"].validate(" 42 "), name).toEqual({ value: " 42 " });
		}
	});
});
