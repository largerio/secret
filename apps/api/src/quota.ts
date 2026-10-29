import { sql } from "drizzle-orm";
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
 * Whether a write of `incomingBytes` would push storage usage past the
 * operator's quota. A quota of 0 disables the check entirely.
 */
export function exceedsQuota(db: AppDatabase, quotaBytes: number, incomingBytes: number): boolean {
	if (!(quotaBytes > 0)) {
		return false;
	}
	return getStorageUsedBytes(db) + incomingBytes > quotaBytes;
}
