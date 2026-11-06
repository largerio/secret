import { EXPIRATION_OPTIONS } from "@largerio/secret-shared";

/**
 * The expiration choices this instance will actually accept.
 *
 * The API enforces MAX_EXPIRY per request, but the picker used to list every
 * option regardless — so an operator tightening retention to 7 days left a
 * "30 days" entry in the UI that failed with a raw 400 on submit. Never returns
 * an empty list: if the ceiling is below even the shortest option, offering the
 * shortest one and letting the server reject it beats a picker with no choices.
 */
export function allowedExpirationOptions(
	maxExpiry: number,
): ReadonlyArray<(typeof EXPIRATION_OPTIONS)[number]> {
	const allowed = EXPIRATION_OPTIONS.filter((option) => option.value <= maxExpiry);
	return allowed.length > 0 ? allowed : [EXPIRATION_OPTIONS[0]];
}

/**
 * Pick a default expiry that the instance accepts: the configured default when
 * it fits, otherwise the longest option that does.
 */
export function defaultExpiration(maxExpiry: number): number {
	const allowed = allowedExpirationOptions(maxExpiry);
	const preferred = allowed.find((option) => option.value === 86_400);
	if (preferred) return preferred.value;

	// allowedExpirationOptions never returns an empty list, so this is safe and
	// needs no fallback branch.
	return Math.max(...allowed.map((option) => option.value));
}

/** The label of an expiration choice, or undefined for a duration the picker never offers. */
export function expiryLabelKey(
	seconds: number,
): (typeof EXPIRATION_OPTIONS)[number]["labelKey"] | undefined {
	return EXPIRATION_OPTIONS.find((option) => option.value === seconds)?.labelKey;
}
