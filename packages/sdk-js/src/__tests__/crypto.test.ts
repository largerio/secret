import { testVectors } from "@secret/shared";
import { describe, expect, test } from "vitest";
import { decryptNote, encryptNote, ensureInit } from "../crypto.js";

describe("SDK crypto", () => {
	test("encrypts and decrypts a text note without password", async () => {
		await ensureInit();

		const encrypted = await encryptNote({ text: "Hello, SDK!", contentMode: "text" });

		expect(encrypted.encryptedData).toBeTruthy();
		expect(encrypted.clientNonce).toBeTruthy();
		expect(encrypted.keyFragment).toBeTruthy();
		expect(encrypted.salt).toBeUndefined();

		const decrypted = await decryptNote(
			encrypted.encryptedData,
			encrypted.clientNonce,
			encrypted.keyFragment,
		);

		expect(decrypted.text).toBe("Hello, SDK!");
		expect(decrypted.contentMode).toBe("text");
	});

	test("encrypts and decrypts a note with password", async () => {
		await ensureInit();

		const encrypted = await encryptNote(
			{ text: "Secret message", contentMode: "secret" },
			"my-password",
		);

		expect(encrypted.salt).toBeTruthy();

		const decrypted = await decryptNote(
			encrypted.encryptedData,
			encrypted.clientNonce,
			encrypted.keyFragment,
			"my-password",
			encrypted.salt,
		);

		expect(decrypted.text).toBe("Secret message");
	});

	test("fails to decrypt with wrong password", async () => {
		await ensureInit();

		const encrypted = await encryptNote({ text: "Secret" }, "correct-password");

		await expect(
			decryptNote(
				encrypted.encryptedData,
				encrypted.clientNonce,
				encrypted.keyFragment,
				"wrong-password",
				encrypted.salt,
			),
		).rejects.toThrow();
	});

	test("encrypts and decrypts a note with files", async () => {
		await ensureInit();

		const fileData = new TextEncoder().encode("file content");
		const encrypted = await encryptNote({
			text: "Note with file",
			files: [{ name: "test.txt", type: "text/plain", size: fileData.length, data: fileData }],
		});

		const decrypted = await decryptNote(
			encrypted.encryptedData,
			encrypted.clientNonce,
			encrypted.keyFragment,
		);

		expect(decrypted.text).toBe("Note with file");
		expect(decrypted.files).toHaveLength(1);
		expect(decrypted.files![0]!.name).toBe("test.txt");
	});

	test("is compatible with test vectors", async () => {
		await ensureInit();

		for (const v of testVectors.vectors.pipeline) {
			const { fromBase64 } = await import("@secret/crypto/client");
			const nonce = fromBase64(v.nonce);
			const key = fromBase64(v.key);

			const { decryptPayload } = await import("@secret/crypto/client");
			const payload = decryptPayload(fromBase64(v.ciphertext), nonce, key);
			expect(payload.text).toBe(v.payload.text);
		}
	});
});
