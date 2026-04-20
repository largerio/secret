import { timingSafeEqual } from "node:crypto";

// Checks every known key without short-circuiting so the time taken doesn't
// reveal which key matched (or that no key matched). timingSafeEqual itself
// requires equal-length buffers, hence the per-key length check.
export function verifyApiKey(candidate: string, knownKeys: ReadonlyArray<string>): boolean {
	const candidateBuf = Buffer.from(candidate);
	let matched = false;

	for (const known of knownKeys) {
		const knownBuf = Buffer.from(known);
		if (candidateBuf.length === knownBuf.length && timingSafeEqual(candidateBuf, knownBuf)) {
			matched = true;
		}
	}

	return matched;
}
