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

// Ambiguous characters (0/O, 1/l/I) are excluded so generated passwords
// can be read aloud or retyped without confusion.
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";

/** Generate a random password from display-safe characters. */
export function generatePassword(length = 20): string {
	const values = new Uint32Array(length);
	crypto.getRandomValues(values);
	let password = "";
	// Iterating the typed array yields `number` (not `number | undefined`), so no
	// index fallback is needed.
	for (const value of values) {
		password += PASSWORD_CHARS[value % PASSWORD_CHARS.length];
	}
	return password;
}
