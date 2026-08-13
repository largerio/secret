import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDatabase } from "./db/index.js";

/**
 * Bytes of encrypted payload currently accounted for: finished notes plus the
 * chunks of in-flight upload sessions. Derived with SUMs instead of a running
 * counter so it can never drift; both tables stay small because notes expire.
 */
export function getStorageUsedBytes(db: AppDatabase): number {
	// A scalar SELECT always yields exactly one row.
	const row = db.get<{ used: number }>(sql`
		SELECT (SELECT COALESCE(SUM(size_bytes), 0) FROM notes)
		     + (SELECT COALESCE(SUM(size_bytes), 0) FROM upload_chunks) AS used
	`) as { used: number };
	return row.used;
}

/**
 * Refuse a write that would push storage usage past the operator's quota.
 * A quota of 0 (or an unset context value) disables the check entirely.
 *
 * 507 Insufficient Storage tells the client the *server* is full — unlike 413,
 * which says the request itself is too large. Writes recover on their own as
 * notes expire or are deleted.
 */
export function assertStorageQuota(
	db: AppDatabase,
	quotaBytes: number,
	incomingBytes: number,
): void {
	if (!(quotaBytes > 0)) {
		return;
	}
	if (getStorageUsedBytes(db) + incomingBytes <= quotaBytes) {
		return;
	}
	throw new HTTPException(507, { message: "Storage quota exceeded" });
}
