export interface AttachLimits {
	/** Largest single file, which is also the cap on all files together (bytes). */
	readonly maxFileSize: number;
	readonly maxFilesPerNote: number;
}

export type AttachError =
	| { readonly kind: "fileTooLarge"; readonly limit: number }
	| { readonly kind: "tooMany"; readonly max: number; readonly ignored: number }
	| { readonly kind: "totalTooLarge"; readonly limit: number };

export interface AttachResult {
	readonly files: File[];
	readonly error: AttachError | null;
}

/**
 * Add files to a note's attachments, within the instance's limits.
 *
 * An oversized file, or a batch that would push the total over the limit,
 * is refused whole. Files past the count limit are dropped but reported:
 * truncating in silence left people guessing why nothing happened.
 */
export function attachFiles(
	current: readonly File[],
	incoming: readonly File[],
	limits: AttachLimits,
): AttachResult {
	const { maxFileSize, maxFilesPerNote } = limits;

	if (incoming.some((file) => file.size > maxFileSize)) {
		return { files: [...current], error: { kind: "fileTooLarge", limit: maxFileSize } };
	}

	const remaining = Math.max(maxFilesPerNote - current.length, 0);
	const overflow: AttachError | null =
		incoming.length > remaining
			? { kind: "tooMany", max: maxFilesPerNote, ignored: incoming.length - remaining }
			: null;
	if (remaining === 0) return { files: [...current], error: overflow };

	const candidates = [...current, ...incoming.slice(0, remaining)];
	const total = candidates.reduce((sum, file) => sum + file.size, 0);
	if (total > maxFileSize) {
		return { files: [...current], error: { kind: "totalTooLarge", limit: maxFileSize } };
	}

	return { files: candidates, error: overflow };
}
