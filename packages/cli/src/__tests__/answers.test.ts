import { describe, expect, it } from "vitest";
import { readBodyAtMost } from "../answers.js";

/** A response whose body comes in these chunks. */
function streamed(...chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		}),
	);
}

describe("readBodyAtMost", () => {
	it("reads a body as long as the limit, over several chunks", async () => {
		expect(await readBodyAtMost(streamed("ab", "cd", "é"), 6)).toBe("abcdé");
	});

	it("stops past the limit", async () => {
		expect(await readBodyAtMost(streamed("ab", "cd", "ef", "g"), 6)).toBeUndefined();
	});

	it("reads no body as nothing", async () => {
		expect(await readBodyAtMost(new Response(null), 6)).toBe("");
	});
});
