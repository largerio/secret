/**
 * The body of a format 1 note (PROTOCOL.md): the length of its head, its head,
 * its file bytes, then zero bytes up to its size class, which is all the
 * server learns of its size.
 *
 * Pure TypeScript, no dependency: the API checks the lengths it sees with it,
 * the SDK pads and reads bodies with it.
 */

/** Every body up to this many bytes is padded to it. */
export const BODY_FLOOR = 4096;

/** The bytes in front of the head that give its length, unsigned big-endian. */
export const HEAD_LENGTH_BYTES = 4;

/** The number of bits it takes to write n: one more than floor(log2(n)), 0 for 0. */
function bitLength(n: number): number {
	let bits = 0;
	for (let rest = n; rest >= 1; rest = Math.floor(rest / 2)) {
		bits++;
	}
	return bits;
}

/**
 * The length of a body whose content takes `length` bytes: Padmé (Nikitin et
 * al., PETS 2019) with a floor. In integers: a floating-point log2 may round
 * up just below a power of two.
 */
export function sizeClass(length: number): number {
	if (!Number.isSafeInteger(length) || length < 0) {
		throw new RangeError("A body's length is a non-negative integer");
	}
	if (length <= BODY_FLOOR) {
		return BODY_FLOOR;
	}
	const e = bitLength(length) - 1;
	const s = bitLength(e);
	// A power of two, so the division and the product are exact.
	const step = 2 ** (e - s);
	return Math.ceil(length / step) * step;
}

/**
 * Whether a body can be this long: a size class is its own, and no other
 * length is one. What the server checks of the messages it is sent.
 */
export function isSizeClass(length: number): boolean {
	return Number.isSafeInteger(length) && length >= BODY_FLOOR && sizeClass(length) === length;
}
