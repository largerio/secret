import { describe, expect, it } from "vitest";
import { generatePassword, getPasswordStrength } from "../password.js";

describe("getPasswordStrength", () => {
	it("returns a neutral result for an empty password", () => {
		const result = getPasswordStrength("");
		expect(result.score).toBe(0);
		expect(result.labelKey).toBeNull();
		expect(result.color).toBe("var(--muted-2)");
	});

	it("scores a very weak password", () => {
		// Short, lowercase only: 0 criteria met
		const result = getPasswordStrength("abc");
		expect(result.score).toBe(0);
		expect(result.labelKey).toBeNull();
	});

	it("scores a weak password", () => {
		// >= 8 chars only
		const result = getPasswordStrength("abcdefgh");
		expect(result.score).toBe(1);
		expect(result.labelKey).toBe("str_vweak");
	});

	it("scores a medium password", () => {
		// >= 8 chars, mixed case, digits
		const result = getPasswordStrength("Abcdef12");
		expect(result.score).toBe(3);
		expect(result.labelKey).toBe("str_ok");
	});

	it("scores a strong password", () => {
		// >= 14 chars, mixed case, digits
		const result = getPasswordStrength("Abcdefghijkl12");
		expect(result.score).toBe(4);
		expect(result.labelKey).toBe("str_strong");
	});

	it("scores an excellent password with all criteria", () => {
		// >= 14 chars, mixed case, digits, symbols
		const result = getPasswordStrength("Abcdefghijk12!@");
		expect(result.score).toBe(5);
		expect(result.labelKey).toBe("str_exc");
	});

	it("assigns a color for every non-empty password", () => {
		expect(getPasswordStrength("abc").color).toBe("#ef4444");
		expect(getPasswordStrength("Abcdefghijk12!@").color).toBe("#10b981");
	});
});

describe("generatePassword", () => {
	it("generates a password of the default length", () => {
		expect(generatePassword()).toHaveLength(20);
	});

	it("generates a password of a custom length", () => {
		expect(generatePassword(32)).toHaveLength(32);
		expect(generatePassword(8)).toHaveLength(8);
	});

	it("only uses display-safe characters", () => {
		const password = generatePassword(100);
		expect(password).toMatch(/^[A-HJ-NP-Za-hj-km-z2-9!@#$%]+$/);
		// Ambiguous characters are excluded
		expect(password).not.toMatch(/[0OIl1]/);
	});

	it("generates different passwords on each call", () => {
		expect(generatePassword()).not.toBe(generatePassword());
	});

	it("rates its own output as excellent", () => {
		const result = getPasswordStrength(generatePassword());
		expect(result.score).toBeGreaterThanOrEqual(4);
	});
});
