/** Which character classes a generated password may draw from. */
export interface PasswordOptions {
	readonly uppercase?: boolean;
	readonly lowercase?: boolean;
	readonly digits?: boolean;
	readonly symbols?: boolean;
}

// Ambiguous characters (0/O, 1/l/I) are excluded so generated passwords
// can be read aloud or retyped without confusion.
const CHARSETS = {
	uppercase: "ABCDEFGHJKLMNPQRSTUVWXYZ",
	lowercase: "abcdefghjkmnpqrstuvwxyz",
	digits: "23456789",
	symbols: "!@#$%",
} as const;

/**
 * Draw a uniform integer in [0, max) from the CSPRNG. Rejection sampling
 * discards the tail of the 32-bit range that would otherwise introduce modulo
 * bias, so every character is equally likely regardless of charset size.
 */
function uniformIndex(max: number): number {
	const limit = Math.floor(0x1_0000_0000 / max) * max;
	const array = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(array);
		/* v8 ignore next */
		const value = array[0] ?? 0;
		if (value < limit) return value % max;
	}
}

const ALL_CLASSES: PasswordOptions = {
	uppercase: true,
	lowercase: true,
	digits: true,
	symbols: true,
};

/** The charsets `options` enables, lowercase alone when it enables none. */
function enabledCharsets(options: PasswordOptions = ALL_CLASSES): string[] {
	const classes = (Object.keys(CHARSETS) as Array<keyof typeof CHARSETS>)
		.filter((name) => options[name])
		.map((name) => CHARSETS[name]);
	return classes.length > 0 ? classes : [CHARSETS.lowercase];
}

function pick(charset: string): string {
	return charset.charAt(uniformIndex(charset.length));
}

/**
 * Generate a random password from display-safe characters. By default every
 * character class is enabled; pass `options` to restrict the charset. If no
 * class is enabled the lowercase set is used as a safe fallback.
 *
 * When the length allows it, the password holds at least one character of
 * each enabled class, each at a random position.
 */
export function generatePassword(length = 20, options?: PasswordOptions): string {
	const classes = enabledCharsets(options);
	const charset = classes.join("");
	const guaranteed = length >= classes.length ? classes : [];
	const chars: string[] = [];
	for (let i = guaranteed.length; i < length; i++) {
		chars.push(pick(charset));
	}
	for (const set of guaranteed) {
		chars.splice(uniformIndex(chars.length + 1), 0, pick(set));
	}
	return chars.join("");
}

export type EntropyRating = "weak" | "fair" | "strong" | "excellent";

/**
 * Entropy of a password `generatePassword` would draw with these settings, in
 * bits, counting every character as a uniform pick from the enabled charsets.
 * The one-character-per-class guarantee costs a fraction of a bit, ignored here.
 */
export function passwordEntropy(length = 20, options?: PasswordOptions): number {
	const pool = enabledCharsets(options).join("").length;
	return Math.round(length * Math.log2(pool));
}

/** A word for an entropy figure, on the usual offline-attack scale. */
export function rateEntropy(bits: number): EntropyRating {
	if (bits < 50) return "weak";
	if (bits < 80) return "fair";
	if (bits < 110) return "strong";
	return "excellent";
}
