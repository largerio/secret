/**
 * Reads a note has left, or null when that cannot be told: the note has no
 * read limit (`maxReads` 0), or the instance does not report `readCount`.
 */
export function readsLeft(maxReads: number, readCount: number | null): number | null {
	if (maxReads <= 0 || readCount === null) return null;
	return Math.max(maxReads - readCount, 0);
}
