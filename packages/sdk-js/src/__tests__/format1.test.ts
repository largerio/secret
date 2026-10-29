import { createHash } from "node:crypto";
import {
	decryptRaw,
	deriveFormat1Keys,
	encodeRaw,
	encryptChunk,
	encryptPayload,
	fromBase64,
	generateKey,
	generateNonce,
	initStreamEncrypt,
	keyFromBase64Url,
	keyToBase64Url,
	toBase64,
} from "@largerio/secret-crypto/client";
import {
	type Envelope,
	encodeEnvelope,
	type NotePayload,
	parseEnvelope,
	testVectors,
} from "@largerio/secret-shared";
import { ExtData } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers-sumo";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ensureInit } from "../crypto.js";
import { SecretValidationError } from "../errors.js";
import {
	assertFormat1Fragment,
	closeFormat1Read,
	encryptNoteChunkedFormat1,
	encryptNoteFormat1,
	formatOfFragment,
	openChunkedFormat1,
	openSingleShotFormat1,
	prepareFormat1Read,
} from "../format1.js";

beforeAll(async () => {
	await ensureInit();
});

// Argon2id at the writer's 256 MiB runs in several test files at once.
const ARGON2_TIMEOUT = 30_000;

const settings = { fileCount: 0, maxReads: 1, expiresIn: 3600 };

const file = (name: string, data: Uint8Array) => ({
	name,
	type: "application/octet-stream",
	size: data.length,
	data,
});

/** Opens a single-shot note as a reader does: proofs from the envelope, then the ciphertext. */
async function decryptNoteFormat1(
	ciphertext: Uint8Array,
	envelope: Uint8Array,
	keyFragment: string,
	password?: string,
): Promise<NotePayload> {
	const read = await prepareFormat1Read(toBase64(envelope), keyFragment, password);
	try {
		return openSingleShotFormat1(read, ciphertext);
	} finally {
		closeFormat1Read(read);
	}
}

/** Opens a chunked note as a reader does. */
async function decryptNoteChunkedFormat1(
	chunks: Uint8Array[],
	envelope: Uint8Array,
	keyFragment: string,
	password?: string,
): Promise<NotePayload> {
	const read = await prepareFormat1Read(toBase64(envelope), keyFragment, password);
	try {
		return openChunkedFormat1(read, chunks);
	} finally {
		closeFormat1Read(read);
	}
}

/**
 * Records the secrets a note's keys are made of, as libsodium hands them out:
 * the link keys it draws or decodes, and every HMAC-SHA256 output (the PRKs,
 * the keys, the proofs). `alive` lists those not wiped yet.
 */
function recordSecrets() {
	const linkKeys: Uint8Array[] = [];
	const hmacs: Uint8Array[] = [];
	const keygen = sodium.crypto_aead_xchacha20poly1305_ietf_keygen;
	const fromBase64Of = sodium.from_base64;
	const hmac = sodium.crypto_auth_hmacsha256;
	const spies = [
		vi.spyOn(sodium, "crypto_aead_xchacha20poly1305_ietf_keygen").mockImplementation((() => {
			const key = keygen();
			linkKeys.push(key);
			return key;
		}) as typeof keygen),
		vi.spyOn(sodium, "from_base64").mockImplementation((input, variant) => {
			const bytes = fromBase64Of(input, variant);
			if (variant === sodium.base64_variants.URLSAFE_NO_PADDING) linkKeys.push(bytes);
			return bytes;
		}),
		vi.spyOn(sodium, "crypto_auth_hmacsha256").mockImplementation(((
			message: Uint8Array,
			key: Uint8Array,
		) => {
			const output = hmac(message, key);
			hmacs.push(output);
			return output;
		}) as typeof hmac),
	];
	return {
		linkKeys,
		alive: () => [...linkKeys, ...hmacs].filter((secret) => secret.some((byte) => byte !== 0)),
		restore: () => {
			for (const spy of spies) spy.mockRestore();
		},
	};
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("base64");

const withFiles: NotePayload = {
	text: "two files",
	contentMode: "markdown",
	files: [file("a.bin", new Uint8Array(10).fill(1)), file("empty", new Uint8Array(0))],
};

/** A format 1 note sealed by hand, around any plaintext, under a valid envelope. */
function forgeSingleShot(plaintext: unknown, fileCount = 0) {
	const linkKey = generateKey();
	const nonce = generateNonce();
	const envelope = encodeEnvelope({ kind: "single-shot", nonce, ...settings, fileCount });
	const { ciphertext } = encryptPayload(
		plaintext as NotePayload,
		deriveFormat1Keys(linkKey).encryptionKey,
		nonce,
		envelope,
	);
	return { ciphertext, envelope, keyFragment: `1.${keyToBase64Url(linkKey)}` };
}

/**
 * A chunked format 1 note sealed by hand: each message, the last one FINAL, or
 * with the tags given.
 */
function forgeChunked(messages: Uint8Array[], fileCount = 0, tags?: number[]) {
	const linkKey = generateKey();
	const { state, header } = initStreamEncrypt(deriveFormat1Keys(linkKey).encryptionKey);
	const envelope = encodeEnvelope({
		kind: "chunked",
		streamHeader: header,
		...settings,
		fileCount,
	});
	const chunks = messages.map((message, i) => {
		const tag = tags?.[i];
		return tag === undefined
			? encryptChunk(state, message, i === messages.length - 1, envelope)
			: sodium.crypto_secretstream_xchacha20poly1305_push(state, message, envelope, tag);
	});
	return { chunks, envelope, keyFragment: `1.${keyToBase64Url(linkKey)}` };
}

function vectorPayload(payload: {
	readonly text: string;
	readonly contentMode: string;
	readonly files?: ReadonlyArray<{ name: string; type: string; size: number; data: string }>;
}): NotePayload {
	return {
		text: payload.text,
		contentMode: payload.contentMode as NotePayload["contentMode"] & string,
		...(payload.files
			? { files: payload.files.map((f) => ({ ...f, data: fromBase64(f.data) })) }
			: {}),
	};
}

describe("format 1 fragments", () => {
	test("start with 1. then the key", async () => {
		const { keyFragment } = await encryptNoteFormat1({ text: "x" }, settings);
		expect(keyFragment).toMatch(/^1\.[A-Za-z0-9_-]{43}$/);
		expect(formatOfFragment(keyFragment)).toBe(1);
		expect(() => assertFormat1Fragment(keyFragment)).not.toThrow();
	});

	test("are told apart from format 0 keys, which never hold a dot", () => {
		expect(formatOfFragment(keyToBase64Url(generateKey()))).toBe(0);
		expect(formatOfFragment("12345")).toBe(0);
	});

	test.each(["0.", "2.", "10."])("refuse a link of another format, %s", (prefix) => {
		const keyFragment = `${prefix}${keyToBase64Url(generateKey())}`;
		expect(() => formatOfFragment(keyFragment)).toThrow(
			new SecretValidationError("Unsupported note format"),
		);
	});

	test.each([
		["too short", "1.abc"],
		["too long", `1.${"A".repeat(44)}`],
		["outside base64url", `1.${"+".repeat(43)}`],
		// 43 characters carry 258 bits: the last one's two low bits must be 0.
		["stray bits in the last character", `1.${"A".repeat(42)}B`],
	])("refuse a key %s", (_, keyFragment) => {
		expect(() => assertFormat1Fragment(keyFragment)).toThrow(
			new SecretValidationError("Invalid key fragment"),
		);
	});
});

describe("single-shot format 1 notes", () => {
	test("round-trip without a password, with an envelope that says so", async () => {
		const written = await encryptNoteFormat1(withFiles, { ...settings, fileCount: 2 });
		const envelope = fromBase64(written.envelope);
		expect(parseEnvelope(envelope)).toMatchObject({
			kind: "single-shot",
			fileCount: 2,
			maxReads: 1,
			expiresIn: 3600,
		});
		expect(parseEnvelope(envelope)?.argon2).toBeUndefined();
		expect(written.encryptedData).toBe(toBase64(written.encryptedBytes));

		const read = await decryptNoteFormat1(written.encryptedBytes, envelope, written.keyFragment);
		expect(read).toEqual(withFiles);
	});

	test(
		"round-trip with a password typed in another Unicode form",
		async () => {
			const written = await encryptNoteFormat1(
				{ text: "hi" },
				settings,
				"Pässwörd".normalize("NFC"),
			);
			const envelope = fromBase64(written.envelope);
			expect(parseEnvelope(envelope)?.argon2).toMatchObject({ iterations: 3, memoryKiB: 262_144 });

			const read = await decryptNoteFormat1(
				written.encryptedBytes,
				envelope,
				written.keyFragment,
				"Pässwörd".normalize("NFD"),
			);
			expect(read).toEqual({ text: "hi" });
			await expect(
				decryptNoteFormat1(written.encryptedBytes, envelope, written.keyFragment, "wrong"),
			).rejects.toThrow();
			await expect(
				decryptNoteFormat1(written.encryptedBytes, envelope, written.keyFragment),
			).rejects.toThrow("The note requires a password");
		},
		ARGON2_TIMEOUT,
	);

	test("round-trip files without any text", async () => {
		const payload: NotePayload = { files: [file("only.bin", new Uint8Array([5]))] };
		const written = await encryptNoteFormat1(payload, { ...settings, fileCount: 1 });
		const read = await decryptNoteFormat1(
			written.encryptedBytes,
			fromBase64(written.envelope),
			written.keyFragment,
		);
		expect(read).toEqual(payload);
	});

	test("ignore a password given for a note without one", async () => {
		const written = await encryptNoteFormat1({ text: "hi" }, settings);
		const read = await decryptNoteFormat1(
			written.encryptedBytes,
			fromBase64(written.envelope),
			written.keyFragment,
			"unused",
		);
		expect(read).toEqual({ text: "hi" });
	});

	test("do not open once a byte of the envelope changed", async () => {
		const written = await encryptNoteFormat1({ text: "hi" }, settings);
		const envelope = fromBase64(written.envelope);
		envelope[5] = 0xff; // maxReads
		await expect(
			decryptNoteFormat1(written.encryptedBytes, envelope, written.keyFragment),
		).rejects.toThrow();
	});

	test("do not open under a chunked envelope", async () => {
		const written = await encryptNoteFormat1({ text: "hi" }, settings);
		const chunked = encodeEnvelope({ kind: "chunked", streamHeader: generateNonce(), ...settings });
		await expect(
			decryptNoteFormat1(written.encryptedBytes, chunked, written.keyFragment),
		).rejects.toThrow("Not a single-shot note");
	});

	test("refuse settings the envelope cannot carry, before stretching the password", async () => {
		const pwhash = vi.spyOn(sodium, "crypto_pwhash");
		try {
			await expect(
				encryptNoteFormat1({ text: "hi" }, { ...settings, maxReads: 70_000 }, "pw"),
			).rejects.toThrow(new SecretValidationError("maxReads must be an integer from 0 to 65535"));
			await expect(
				encryptNoteChunkedFormat1({ text: "hi" }, 4, { ...settings, expiresIn: -1 }, "pw"),
			).rejects.toThrow(
				new SecretValidationError("expiresIn must be an integer from 0 to 4294967295"),
			);
			expect(pwhash).not.toHaveBeenCalled();
		} finally {
			pwhash.mockRestore();
		}
	});

	test("write strings as valid UTF-8, a lone surrogate as U+FFFD", async () => {
		const payload: NotePayload = {
			text: "cut\uD83D",
			files: [{ name: "\uDE00name", type: "t", size: 0, data: new Uint8Array() }],
		};
		const written = await encryptNoteFormat1(payload, { ...settings, fileCount: 1 });
		const read = await decryptNoteFormat1(
			written.encryptedBytes,
			fromBase64(written.envelope),
			written.keyFragment,
		);
		expect(read).toEqual({
			text: "cut\uFFFD",
			files: [{ name: "\uFFFDname", type: "t", size: 0, data: new Uint8Array() }],
		});
	});

	test(
		"hold the payload as the vectors record",
		async () => {
			for (const v of testVectors.vectors.format1.pipeline) {
				const read = await decryptNoteFormat1(
					fromBase64(v.ciphertext),
					fromBase64(v.envelope),
					v.keyFragment,
					v.password,
				);
				expect(read, v.description).toEqual(vectorPayload(v.payload));
			}
		},
		ARGON2_TIMEOUT,
	);

	// The nonce is random, so the ciphertext differs: its plaintext must not.
	test("are written as the vectors record", async () => {
		for (const v of testVectors.vectors.format1.pipeline.filter((vector) => !vector.password)) {
			const payload = vectorPayload(v.payload);
			const written = await encryptNoteFormat1(payload, {
				...settings,
				fileCount: payload.files?.length ?? 0,
			});
			const envelope = fromBase64(written.envelope);
			const parsed = parseEnvelope(envelope) as Extract<Envelope, { kind: "single-shot" }>;
			const linkKey = keyFromBase64Url(written.keyFragment.slice(2));
			const plaintext = decryptRaw(
				written.encryptedBytes,
				parsed.nonce,
				deriveFormat1Keys(linkKey).encryptionKey,
				envelope,
			);
			expect(toBase64(plaintext), v.description).toBe(v.payloadMsgpack);
		}
	});
});

describe("the payload of a single-shot format 1 note", () => {
	const bin = new Uint8Array([1, 2]);
	const goodFile = { name: "a", type: "t", size: 2, data: bin };

	test.each([
		["an array", [1, 2]],
		["a string", "text"],
		["bytes", new Uint8Array([1])],
		["nil", null],
		["a timestamp extension", new Date(0)],
		["another extension", new ExtData(5, new Uint8Array([1]))],
		["a text that is not a string", { text: 3 }],
		["a nil text", { text: null }],
		["a nil content mode", { contentMode: null }],
		["nil files", { files: null }],
		["an unknown content mode", { contentMode: "html" }],
		["files that are not an array", { files: "a" }],
		["more than 10 files", { files: Array.from({ length: 11 }, () => goodFile) }],
		["a file without a name", { files: [{ ...goodFile, name: 1 }] }],
		["a file without a type", { files: [{ ...goodFile, type: undefined }] }],
		["a file without a size", { files: [{ name: "a", type: "t", data: bin }] }],
		["a negative size", { files: [{ ...goodFile, size: -1 }] }],
		["a fractional size", { files: [{ ...goodFile, size: 1.5 }] }],
		["data that is not bytes", { files: [{ ...goodFile, data: "ab" }] }],
		["data shorter than its size", { files: [{ ...goodFile, size: 3 }] }],
		["data longer than its size", { files: [{ ...goodFile, size: 1 }] }],
		["a file that is not a map", { files: [[1]] }],
	])("is refused when it is %s", async (_, plaintext) => {
		const files = (plaintext as { files?: unknown } | null)?.files;
		const forged = forgeSingleShot(plaintext, Array.isArray(files) ? files.length : 0);
		await expect(
			decryptNoteFormat1(forged.ciphertext, forged.envelope, forged.keyFragment),
		).rejects.toThrow("Malformed payload");
	});

	test("may hold 10 files, the most a note holds", async () => {
		const files = Array.from({ length: 10 }, () => goodFile);
		const forged = forgeSingleShot({ files }, 10);
		const read = await decryptNoteFormat1(forged.ciphertext, forged.envelope, forged.keyFragment);
		expect(read.files).toHaveLength(10);
	});

	test("must hold as many files as its envelope declares", async () => {
		const forged = forgeSingleShot({ files: [goodFile] }, 2);
		await expect(
			decryptNoteFormat1(forged.ciphertext, forged.envelope, forged.keyFragment),
		).rejects.toThrow("The payload does not hold the files its envelope declares");
	});

	test("is rebuilt from its known keys, unknown ones left out", async () => {
		const forged = forgeSingleShot({ text: "t", future: 1, files: [{ ...goodFile, extra: 2 }] }, 1);
		const read = await decryptNoteFormat1(forged.ciphertext, forged.envelope, forged.keyFragment);
		expect(read).toEqual({ text: "t", files: [goodFile] });
	});
});

describe("chunked format 1 notes", () => {
	test("round-trip files, empty ones included", async () => {
		const written = await encryptNoteChunkedFormat1(withFiles, 4, { ...settings, fileCount: 2 });
		expect(written.chunks).toHaveLength(4); // the head, then 10 bytes in 4-byte pieces
		const envelope = fromBase64(written.envelope);
		expect(parseEnvelope(envelope)).toMatchObject({ kind: "chunked", fileCount: 2 });

		const read = await decryptNoteChunkedFormat1(written.chunks, envelope, written.keyFragment);
		expect(read).toEqual(withFiles);
	});

	test(
		"round-trip with a password",
		async () => {
			const written = await encryptNoteChunkedFormat1({ text: "t" }, 4, settings, "pw");
			const envelope = fromBase64(written.envelope);
			expect(parseEnvelope(envelope)?.argon2).toBeDefined();
			await expect(
				decryptNoteChunkedFormat1(written.chunks, envelope, written.keyFragment, "pw"),
			).resolves.toEqual({ text: "t" });
		},
		ARGON2_TIMEOUT,
	);

	test("do not open once a byte of the envelope changed, or under a single-shot one", async () => {
		const written = await encryptNoteChunkedFormat1({ text: "t" }, 4, settings);
		const altered = fromBase64(written.envelope);
		altered[9] = (altered[9] ?? 0) ^ 1; // expiresIn
		await expect(
			decryptNoteChunkedFormat1(written.chunks, altered, written.keyFragment),
		).rejects.toThrow();

		const singleShot = encodeEnvelope({ kind: "single-shot", nonce: generateNonce(), ...settings });
		await expect(
			decryptNoteChunkedFormat1(written.chunks, singleShot, written.keyFragment),
		).rejects.toThrow("Not a chunked note");
	});

	test("refuse file bytes beyond the sizes the head declares", async () => {
		const head = encodeRaw({ files: [{ name: "a", type: "t", size: 2 }] });
		const forged = forgeChunked([head, new Uint8Array([1, 2, 3])], 1);
		await expect(
			decryptNoteChunkedFormat1(forged.chunks, forged.envelope, forged.keyFragment),
		).rejects.toThrow("does not match the declared size");
	});

	test.each([
		["not a map", [1]],
		["an extension", new Date(0)],
		["a nil text", { text: null }],
		["nil files", { files: null }],
		[
			"more than 10 files",
			{ files: Array.from({ length: 11 }, () => ({ name: "a", type: "t", size: 0 })) },
		],
		["a negative size", { files: [{ name: "a", type: "t", size: -1 }] }],
		["a file without a size", { files: [{ name: "a", type: "t" }] }],
	])("refuse a head that is %s", async (_, head) => {
		const forged = forgeChunked([encodeRaw(head)]);
		await expect(
			decryptNoteChunkedFormat1(forged.chunks, forged.envelope, forged.keyFragment),
		).rejects.toThrow("Unable to decrypt");
	});

	test("refuse a tag other than MESSAGE before the FINAL chunk", async () => {
		const head = encodeRaw({ files: [{ name: "a", type: "t", size: 2 }] });
		const MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
		const FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
		const piece = new Uint8Array([1]);
		for (const tags of [
			[sodium.crypto_secretstream_xchacha20poly1305_TAG_PUSH, MESSAGE, FINAL],
			[MESSAGE, sodium.crypto_secretstream_xchacha20poly1305_TAG_REKEY, FINAL],
		]) {
			const forged = forgeChunked([head, piece, piece], 1, tags);
			await expect(
				decryptNoteChunkedFormat1(forged.chunks, forged.envelope, forged.keyFragment),
			).rejects.toThrow("Unexpected secretstream tag");
		}
	});

	test("must hold as many files as their envelope declares", async () => {
		const head = encodeRaw({ files: [{ name: "a", type: "t", size: 0 }] });
		const forged = forgeChunked([head], 0);
		await expect(
			decryptNoteChunkedFormat1(forged.chunks, forged.envelope, forged.keyFragment),
		).rejects.toThrow("The payload does not hold the files its envelope declares");
	});

	test(
		"hold the payload as the vectors record",
		async () => {
			for (const v of testVectors.vectors.format1.secretstream) {
				const read = await decryptNoteChunkedFormat1(
					v.chunks.map(fromBase64),
					fromBase64(v.envelope),
					v.keyFragment,
					v.password,
				);
				expect(read, v.description).toEqual(vectorPayload(v.payload));
			}
		},
		ARGON2_TIMEOUT,
	);
});

describe("the verifiers a format 1 writer sends", () => {
	test("check the proofs its readers derive, without a password", async () => {
		const written = await encryptNoteFormat1({ text: "hi" }, settings);
		expect(written.verifiers.passwordVerifier).toBeUndefined();

		const read = await prepareFormat1Read(written.envelope, written.keyFragment, undefined);
		expect(sha256(fromBase64(read.proofs.linkProof))).toBe(written.verifiers.linkVerifier);
		expect(read.proofs.passwordProof).toBeUndefined();
	});

	test(
		"check both proofs of a password note, and tell a wrong password apart",
		async () => {
			const written = await encryptNoteChunkedFormat1({ text: "t" }, 4, settings, "pw");
			const right = await prepareFormat1Read(written.envelope, written.keyFragment, "pw");
			const wrong = await prepareFormat1Read(written.envelope, written.keyFragment, "pW");

			expect(sha256(fromBase64(right.proofs.linkProof))).toBe(written.verifiers.linkVerifier);
			expect(sha256(fromBase64(right.proofs.passwordProof ?? ""))).toBe(
				written.verifiers.passwordVerifier,
			);
			// The link proves the link alone: a wrong password still proves it.
			expect(wrong.proofs.linkProof).toBe(right.proofs.linkProof);
			expect(wrong.proofs.passwordProof).not.toBe(right.proofs.passwordProof);
		},
		ARGON2_TIMEOUT,
	);

	test("differ from note to note", async () => {
		const first = await encryptNoteFormat1({ text: "hi" }, settings);
		const second = await encryptNoteFormat1({ text: "hi" }, settings);
		expect(first.verifiers.linkVerifier).not.toBe(second.verifiers.linkVerifier);
	});
});

describe("preparing a format 1 read", () => {
	test("refuses a note that sent no envelope, or one a reader refuses", async () => {
		const { keyFragment } = await encryptNoteFormat1({ text: "x" }, settings);
		await expect(prepareFormat1Read(undefined, keyFragment, undefined)).rejects.toThrow(
			"Not a format 1 note",
		);
		await expect(
			prepareFormat1Read(toBase64(new Uint8Array([1, 2, 3])), keyFragment, undefined),
		).rejects.toThrow("Not a format 1 envelope");
		await expect(prepareFormat1Read("not base64!", keyFragment, undefined)).rejects.toThrow();
	});

	test("refuses a password note without a password, before stretching anything", async () => {
		const argon2 = { salt: new Uint8Array(16), iterations: 1, memoryKiB: 65_536 };
		const envelope = encodeEnvelope({
			kind: "single-shot",
			nonce: generateNonce(),
			...settings,
			argon2,
		});
		const pwhash = vi.spyOn(sodium, "crypto_pwhash");
		try {
			await expect(
				prepareFormat1Read(toBase64(envelope), `1.${keyToBase64Url(generateKey())}`, undefined),
			).rejects.toThrow("The note requires a password");
			expect(pwhash).not.toHaveBeenCalled();
		} finally {
			pwhash.mockRestore();
		}
	});

	test("refuses a malformed link", async () => {
		const { envelope } = await encryptNoteFormat1({ text: "x" }, settings);
		await expect(prepareFormat1Read(envelope, "1.abc", undefined)).rejects.toThrow(
			new SecretValidationError("Invalid key fragment"),
		);
	});

	test(
		"derives the proofs the vectors record",
		async () => {
			for (const v of testVectors.vectors.format1.keys) {
				const argon2 = v.argon2 && { ...v.argon2, salt: fromBase64(v.argon2.salt) };
				const envelope = encodeEnvelope({
					kind: "single-shot",
					nonce: generateNonce(),
					...settings,
					argon2,
				});
				const read = await prepareFormat1Read(toBase64(envelope), v.keyFragment, v.password);
				expect(read.proofs.linkProof, v.description).toBe(v.linkProof);
				expect(read.proofs.passwordProof, v.description).toBe(v.passwordProof);
				expect(toBase64(read.encryptionKey), v.description).toBe(v.encryptionKey);
			}
		},
		ARGON2_TIMEOUT,
	);

	test(
		"keeps no secret but the key, which closing wipes",
		async () => {
			const { envelope, keyFragment } = await encryptNoteFormat1({ text: "x" }, settings, "pw");
			const secrets = recordSecrets();
			try {
				const read = await prepareFormat1Read(envelope, keyFragment, "pw");
				// The link key, the PRKs and the proofs' bytes: all but the key.
				expect(secrets.linkKeys).toHaveLength(1);
				expect(secrets.alive().filter((secret) => secret !== read.encryptionKey)).toEqual([]);

				closeFormat1Read(read);
				expect(secrets.alive()).toEqual([]);
			} finally {
				secrets.restore();
			}
		},
		ARGON2_TIMEOUT,
	);
});

describe("a format 1 writer", () => {
	test.each([
		["single-shot", () => encryptNoteFormat1({ text: "x" }, settings, "pw")],
		["chunked", () => encryptNoteChunkedFormat1({ text: "x" }, 4, settings, "pw")],
	])(
		"keeps no secret once a %s note is written",
		async (_, write) => {
			const secrets = recordSecrets();
			try {
				await write();
				expect(secrets.linkKeys).toHaveLength(1);
				expect(secrets.alive()).toEqual([]);
			} finally {
				secrets.restore();
			}
		},
		ARGON2_TIMEOUT,
	);
});
