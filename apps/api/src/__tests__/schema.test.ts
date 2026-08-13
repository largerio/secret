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

	it("declares the indexes the migrations create", () => {
		// drizzle-kit diffs future migrations against this schema, so the declared
		// indexes must match what the baseline migration actually creates.
		const indexNames = (table: Parameters<typeof getTableConfig>[0]) =>
			getTableConfig(table)
				.indexes.map((index) => index.config.name)
				.sort();

		expect(indexNames(notes)).toEqual(["idx_notes_delete_token", "idx_notes_expires_at"]);
		expect(indexNames(uploads)).toEqual(["idx_uploads_expires_at"]);
		expect(indexNames(pendingDeletions)).toEqual(["idx_pending_deletions_next_retry"]);
	});

	it("cascades upload_chunks rows when their upload session is deleted", () => {
		const { foreignKeys } = getTableConfig(uploadChunks);
		expect(foreignKeys).toHaveLength(1);

		const foreignKey = foreignKeys[0];
		expect(foreignKey?.onDelete).toBe("cascade");

		const reference = foreignKey?.reference();
		expect(reference?.columns.map((column) => column.name)).toEqual(["upload_id"]);
		expect(reference?.foreignColumns.map((column) => column.name)).toEqual(["id"]);
	});
});
