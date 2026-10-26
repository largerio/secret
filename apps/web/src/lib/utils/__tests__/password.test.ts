import { describe, expect, it, vi } from "vitest";
import { generatePassword, passwordEntropy, rateEntropy } from "../password.js";

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

	it("holds a character of every enabled class", () => {
		for (let i = 0; i < 500; i++) {
			const password = generatePassword(4, { uppercase: true, digits: true, symbols: true });
			expect(password).toMatch(/[A-Z]/);
			expect(password).toMatch(/[2-9]/);
			expect(password).toMatch(/[!@#$%]/);
		}
	});

	it("puts the guaranteed characters at random positions", () => {
		const orders = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const password = generatePassword(2, { lowercase: true, symbols: true });
			expect(password).toMatch(/^([a-z][!@#$%]|[!@#$%][a-z])$/);
			orders.add(/^[a-z]/.test(password) ? "letter first" : "symbol first");
		}
		expect(orders.size).toBe(2);
	});

	it("guarantees no class when the length is shorter than the class count", () => {
		expect(generatePassword(3)).toMatch(/^[A-HJ-NP-Za-hj-km-z2-9!@#$%]{3}$/);
	});

	it("restricts the charset to the requested character classes", () => {
		expect(generatePassword(60, { digits: true })).toMatch(/^[2-9]+$/);
		expect(generatePassword(60, { uppercase: true })).toMatch(/^[A-HJ-NP-Z]+$/);
		expect(generatePassword(60, { lowercase: true, symbols: true })).toMatch(/^[a-hj-km-z!@#$%]+$/);
	});

	it("falls back to lowercase when every class is disabled", () => {
		const password = generatePassword(60, {
			uppercase: false,
			lowercase: false,
			digits: false,
			symbols: false,
		});
		expect(password).toMatch(/^[a-hj-km-z]+$/);
	});

	it("rejects biased samples from the tail of the random range", () => {
		// First draw lands in the rejected tail (>= limit), second is accepted.
		// This exercises the rejection-sampling loop that removes modulo bias.
		const draws = [4_294_967_290, 5];
		let call = 0;
		const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
			(array as Uint32Array)[0] = draws[call++] ?? 0;
			return array;
		});

		const password = generatePassword(1);

		expect(password).toHaveLength(1);
		expect(spy).toHaveBeenCalledTimes(2);
		spy.mockRestore();
	});
});

describe("passwordEntropy", () => {
	it("counts length times the bits of the enabled pool", () => {
		// 24 + 23 + 8 + 5 = 60 characters.
		expect(passwordEntropy()).toBe(Math.round(20 * Math.log2(60)));
		expect(passwordEntropy(10, { digits: true })).toBe(30);
	});

	it("rates the default settings as excellent", () => {
		expect(rateEntropy(passwordEntropy())).toBe("excellent");
	});

	it("falls back to the lowercase pool like the generator does", () => {
		expect(passwordEntropy(4, {})).toBe(Math.round(4 * Math.log2(23)));
	});
});

describe("rateEntropy", () => {
	it("puts each figure on the scale", () => {
		expect(rateEntropy(49)).toBe("weak");
		expect(rateEntropy(50)).toBe("fair");
		expect(rateEntropy(80)).toBe("strong");
		expect(rateEntropy(110)).toBe("excellent");
	});
});
