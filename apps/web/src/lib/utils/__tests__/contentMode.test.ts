import { describe, expect, it } from "vitest";
import { resolveContentMode } from "../contentMode.js";

describe("resolveContentMode", () => {
	it("sends a note that is only the generated password as a secret", () => {
		expect(
			resolveContentMode("Xk7#mQ2v", { formatted: false, generated: "Xk7#mQ2v", hasFiles: false }),
		).toBe("secret");
	});

	it("ignores whitespace around the password", () => {
		expect(
			resolveContentMode("  Xk7#mQ2v\n", {
				formatted: true,
				generated: "Xk7#mQ2v",
				hasFiles: false,
			}),
		).toBe("secret");
	});

	it("keeps a note that holds more than the password as text or markdown", () => {
		const generated = "Xk7#mQ2v";
		expect(
			resolveContentMode(`login: admin ${generated}`, {
				formatted: false,
				generated,
				hasFiles: false,
			}),
		).toBe("text");
		expect(
			resolveContentMode(`**pw** ${generated}`, { formatted: true, generated, hasFiles: false }),
		).toBe("markdown");
	});

	it("keeps the password as text when files go with it", () => {
		expect(
			resolveContentMode("Xk7#mQ2v", { formatted: false, generated: "Xk7#mQ2v", hasFiles: true }),
		).toBe("text");
	});

	it("never treats a typed password as a secret", () => {
		expect(
			resolveContentMode("hunter2", { formatted: false, generated: null, hasFiles: false }),
		).toBe("text");
		expect(resolveContentMode("", { formatted: false, generated: "", hasFiles: false })).toBe(
			"text",
		);
	});
});
