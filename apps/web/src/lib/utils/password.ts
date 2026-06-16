export type StrengthLabelKey = "str_vweak" | "str_weak" | "str_ok" | "str_strong" | "str_exc";

export interface PasswordStrength {
	readonly score: number;
	readonly labelKey: StrengthLabelKey | null;
	readonly color: string;
}

const STRENGTH_KEYS: readonly StrengthLabelKey[] = [
	"str_vweak",
	"str_weak",
	"str_ok",
	"str_strong",
	"str_exc",
];
const STRENGTH_COLORS: readonly string[] = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#10b981"];

/** Score a password from 0 to 5 based on length and character variety. */
export function getPasswordStrength(password: string): PasswordStrength {
	if (!password) return { score: 0, labelKey: null, color: "var(--muted-2)" };

	let score = 0;
	if (password.length >= 8) score++;
	if (password.length >= 14) score++;
	if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
	if (/\d/.test(password)) score++;
	if (/[^\w\s]/.test(password)) score++;

	const idx = Math.min(score - 1, 4);
	if (idx < 0) return { score, labelKey: null, color: "#ef4444" };

	// idx ∈ [0, 4] here and both arrays have 5 entries, so the `??` fallbacks
	// below are unreachable — they exist only for noUncheckedIndexedAccess.
	/* v8 ignore next */
	const labelKey = STRENGTH_KEYS[idx] ?? null;
	/* v8 ignore next */
	const color = STRENGTH_COLORS[idx] ?? "#ef4444";
	return { score, labelKey, color };
}

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

/**
 * Generate a random password from display-safe characters. By default every
 * character class is enabled; pass `options` to restrict the charset. If no
 * class is enabled the lowercase set is used as a safe fallback.
 */
export function generatePassword(length = 20, options?: PasswordOptions): string {
	const opts = options ?? { uppercase: true, lowercase: true, digits: true, symbols: true };
	let charset = "";
	if (opts.uppercase) charset += CHARSETS.uppercase;
	if (opts.lowercase) charset += CHARSETS.lowercase;
	if (opts.digits) charset += CHARSETS.digits;
	if (opts.symbols) charset += CHARSETS.symbols;
	if (charset.length === 0) charset = CHARSETS.lowercase;

	let password = "";
	for (let i = 0; i < length; i++) {
		password += charset[uniformIndex(charset.length)];
	}
	return password;
}
