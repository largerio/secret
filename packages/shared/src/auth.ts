import { timingSafeEqual } from "node:crypto";

export function verifyApiKey(candidate: string, knownKeys: ReadonlyArray<string>): boolean {
	const candidateBuf = Buffer.from(candidate);

	for (const known of knownKeys) {
		const knownBuf = Buffer.from(known);
		if (candidateBuf.length === knownBuf.length && timingSafeEqual(candidateBuf, knownBuf)) {
			return true;
		}
	}

	return false;
}
