import { MAX_PASSWORD_ATTEMPTS } from "@largerio/secret-shared";

/**
 * Reads a note has left, or null when that cannot be told: the note has no
 * read limit (`maxReads` 0), or the instance does not report `readCount`.
 */
export function readsLeft(maxReads: number, readCount: number | null): number | null {
	if (maxReads <= 0 || readCount === null) return null;
	return Math.max(maxReads - readCount, 0);
}

/**
 * Whether opening the note spends its last read, destroying it. Not only
 * single-read notes: a 3-read note with one read left is just as fragile,
 * a wrong password included.
 */
export function isLastRead(maxReads: number, readCount: number | null): boolean {
	return maxReads === 1 || readsLeft(maxReads, readCount) === 1;
}

/** What the page says about a note's reads before it is opened. */
export type ReadsBefore =
	| { readonly kind: "left"; readonly count: number }
	| { readonly kind: "total"; readonly count: number }
	| { readonly kind: "none" };

export function readsBefore(maxReads: number, readCount: number | null): ReadsBefore {
	const left = readsLeft(maxReads, readCount);
	if (left !== null) return { kind: "left", count: left };
	// An older instance: only the limit is known.
	return maxReads > 0 ? { kind: "total", count: maxReads } : { kind: "none" };
}

/** Where the note stands once read, as the server reported it afterwards. */
export type NoteAfterRead =
	| { readonly exists: false }
	| { readonly exists: true; readonly readCount: number | null };

/** What the page says about the note once it is open. */
export type ReadsAfter =
	| { readonly kind: "gone" }
	| { readonly kind: "left"; readonly count: number }
	| { readonly kind: "limited" }
	| { readonly kind: "unlimited" };

/**
 * @param after What the server said after the read, or null when it could not
 *   be asked. Read from the server rather than worked out locally: other
 *   readers may have spent reads since the page loaded, making this one the last.
 */
export function readsAfter(maxReads: number, after: NoteAfterRead | null): ReadsAfter {
	if (maxReads === 1 || after?.exists === false) return { kind: "gone" };
	if (maxReads <= 0) return { kind: "unlimited" };

	const left = after ? readsLeft(maxReads, after.readCount) : null;
	if (left === null) return { kind: "limited" };
	return left === 0 ? { kind: "gone" } : { kind: "left", count: left };
}

/** What the page says of a format 1 password note's wrong passwords left. */
export type AttemptsLeft =
	| { readonly kind: "last" }
	| { readonly kind: "left"; readonly count: number }
	| { readonly kind: "none" };

/**
 * @param left The attempts the server reported, null when it could not be
 *   asked. Nothing is said while all of them are left: a wrong password spends
 *   no read, and the reader need not hear of a limit until it draws near.
 */
export function attemptsLeft(left: number | null): AttemptsLeft {
	if (left === null || left >= MAX_PASSWORD_ATTEMPTS) return { kind: "none" };
	return left <= 1 ? { kind: "last" } : { kind: "left", count: left };
}
