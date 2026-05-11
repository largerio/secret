import { timingSafeEqual } from "node:crypto";

// Verifies a candidate against every configured key without letting the
// per-iteration runtime depend on the candidate's length. timingSafeEqual
// requires equal-length buffers, so we pad (or truncate) the candidate to the
// known key's length and then combine the byte-equality with a length check.
// The time spent per key depends only on the known key's length, which is not
// a secret to the attacker (keys are fixed at deploy time).
export function verifyApiKeyBuffers(
	candidate: string,
	knownBuffers: ReadonlyArray<Buffer>,
): boolean {
	const candidateBuf = Buffer.from(candidate);
	let matched = false;

	for (const knownBuf of knownBuffers) {
		const padded = Buffer.alloc(knownBuf.length);
		candidateBuf.copy(padded);
		const bytesMatch = timingSafeEqual(padded, knownBuf);
		const lengthsMatch = candidateBuf.length === knownBuf.length;
		if (bytesMatch && lengthsMatch) {
			matched = true;
		}
	}

	return matched;
}

export function verifyApiKey(candidate: string, knownKeys: ReadonlyArray<string>): boolean {
	return verifyApiKeyBuffers(
		candidate,
		knownKeys.map((k) => Buffer.from(k)),
	);
}
