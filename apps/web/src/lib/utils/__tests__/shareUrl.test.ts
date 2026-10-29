import { describe, expect, it } from "vitest";
import { isKeyFragment, splitShareUrl } from "../shareUrl.js";

const KEY = "k7Qm2xLp9vT4nB8rWc3yZ1hF6sJ0dGa5eU_-Ab12Cd3";

describe("splitShareUrl", () => {
	it("separates the scheme, the address and the key", () => {
		expect(splitShareUrl(`https://secret.example.com/note/abc#${KEY}`)).toEqual({
			scheme: "https://",
			address: "secret.example.com/note/abc",
			key: `#${KEY}`,
		});
	});

	it("leaves the key empty when the link has none", () => {
		expect(splitShareUrl("http://localhost:3000/note/abc").key).toBe("");
	});
});

describe("isKeyFragment", () => {
	it("accepts a 32-byte key in unpadded base64url", () => {
		expect(KEY).toHaveLength(43);
		expect(isKeyFragment(KEY)).toBe(true);
	});

	it("refuses a key cut short, padded, or in plain base64", () => {
		expect(isKeyFragment(KEY.slice(0, 30))).toBe(false);
		expect(isKeyFragment(`${KEY}=`)).toBe(false);
		expect(isKeyFragment(KEY.replace("_", "/"))).toBe(false);
		expect(isKeyFragment("")).toBe(false);
	});

	it("accepts a format 1 key, which names its format", () => {
		expect(isKeyFragment(`1.${KEY}`)).toBe(true);
	});

	it("refuses another format number, or a format 1 key cut short", () => {
		expect(isKeyFragment(`2.${KEY}`)).toBe(false);
		expect(isKeyFragment(`1.${KEY.slice(0, 30)}`)).toBe(false);
		expect(isKeyFragment(`1${KEY}`)).toBe(false);
	});
});
