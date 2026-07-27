import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `.env.example` is the operator-facing contract, but `docker-compose.yml` is
 * what actually reaches the container: compose reads `.env` only to interpolate
 * `${VAR}`, so a variable missing from the `environment:` block is dropped in
 * silence. Four of them were — ADDRESS_HEADER, XFF_DEPTH, RATE_LIMIT_MULTIPLIER
 * and ALLOW_SERVER_KEY_CHANGE — which made a documented fix for rate limiting
 * behind a proxy, and the documented escape hatch for a key mismatch, both
 * no-ops that gave no error.
 */

const repoRoot = new URL("../", import.meta.url);

function read(name: string): string {
	return readFileSync(fileURLToPath(new URL(name, repoRoot)), "utf8");
}

/** Every `NAME=` assignment, commented-out ones included — they are documentation too. */
function declaredVariables(envExample: string): ReadonlyArray<string> {
	return envExample
		.split("\n")
		.map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
		.filter((name): name is string => name !== undefined);
}

function forwardedVariables(compose: string): ReadonlyArray<string> {
	return compose
		.split("\n")
		.map((line) => /^\s*-\s+([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
		.filter((name): name is string => name !== undefined);
}

/**
 * `PORT` is consumed by the `ports:` mapping (inside the container the web
 * server always listens on 3000), and `HOST` is fixed by the image. Neither
 * belongs in `environment:`.
 */
const NOT_FORWARDED = new Set(["PORT", "HOST"]);

describe("docker-compose.yml", () => {
	it("forwards every variable .env.example documents", () => {
		const documented = declaredVariables(read(".env.example"));
		const forwarded = new Set(forwardedVariables(read("docker-compose.yml")));

		const dropped = documented.filter((name) => !NOT_FORWARDED.has(name) && !forwarded.has(name));

		expect(dropped).toEqual([]);
	});

	it("reads something from both files", () => {
		expect(declaredVariables(read(".env.example")).length).toBeGreaterThan(20);
		expect(forwardedVariables(read("docker-compose.yml")).length).toBeGreaterThan(20);
	});
});
