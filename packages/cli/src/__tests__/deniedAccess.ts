import type * as fs from "node:fs/promises";

/*
 * A test file mocks `node:fs/promises` with it, its factory importing this
 * module, which `vi.mock`'s hoisting leaves no other way to reach:
 *
 *   vi.mock("node:fs/promises", async (importOriginal) =>
 *     (await import("./deniedAccess.js")).withDeniedAccess(importOriginal),
 *   );
 */

/**
 * The paths `access` refuses, as it would to a user without the right: the
 * tests run as root, to whom it refuses nothing.
 */
export const denied = new Set<string>();

/** `node:fs/promises`, its `access` refusing the paths in `denied`. */
export async function withDeniedAccess(
	importOriginal: () => Promise<typeof fs>,
): Promise<typeof fs> {
	const actual = await importOriginal();
	return {
		...actual,
		access: async (path, mode) => {
			if (denied.has(String(path))) {
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			}
			return actual.access(path, mode);
		},
	};
}
