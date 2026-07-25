import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { meta, notes, pendingDeletions, uploadChunks, uploads } from "../db/schema.js";

describe("db schema", () => {
	it("keys upload chunks by (uploadId, chunkIndex)", () => {
		// A composite primary key is what makes a duplicate chunk upload a no-op
		// instead of a second row; losing it would silently double-count chunks.
		const { primaryKeys } = getTableConfig(uploadChunks);
		expect(primaryKeys).toHaveLength(1);
		expect(primaryKeys[0]?.columns.map((c) => c.name)).toEqual(["upload_id", "chunk_index"]);
	});

	it("declares the tables the runtime creates", () => {
		expect(getTableConfig(notes).name).toBe("notes");
		expect(getTableConfig(uploads).name).toBe("uploads");
		expect(getTableConfig(meta).name).toBe("meta");
		expect(getTableConfig(pendingDeletions).name).toBe("pending_deletions");
	});
});
