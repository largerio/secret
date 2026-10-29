import { createHash } from "node:crypto";
import {
	decryptChunk,
	deriveFormat1Keys,
	encodeRaw,
	encryptChunk,
	fromBase64,
	generateKey,
	generateNonce,
	initStreamDecrypt,
	initStreamEncrypt,
	keyFromBase64Url,
	keyToBase64Url,
	toBase64,
} from "@largerio/secret-crypto/client";
import {
	encodeEnvelope,
	type NotePayload,
	parseEnvelope,
	testVectors,
} from "@largerio/secret-shared";
import { ExtData } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers-sumo";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { concatUint8Arrays, ensureInit } from "../crypto.js";
import { SecretValidationError } from "../errors.js";
import {
	assertFormat1Fragment,
	closeFormat1Read,
	encryptNoteFormat1,
	format1BodyOf,
	formatOfFragment,
	openNoteFormat1,
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

/**
 * Writes a note as the client does: its body laid out, then cut into messages
 * of `messageSize` bytes, the whole body as one message by default.
 */
function write(
	payload: NotePayload,
	options: { readonly messageSize?: number; readonly password?: string } = {},
) {
	const body = format1BodyOf(payload);
	return encryptNoteFormat1(
		body,
		options.messageSize ?? body.length,
		{ ...settings, fileCount: payload.files?.length ?? 0 },
		options.password,
	);
}

/** Opens a note as a reader does: proofs from the envelope, then the messages. */
async function open(
	messages: ReadonlyArray<Uint8Array>,
	envelope: string,
	keyFragment: string,
	password?: string,
): Promise<NotePayload> {
	const read = await prepareFormat1Read(envelope, keyFragment, password);
	try {
		return openNoteFormat1(read, messages);
	} finally {
		closeFormat1Read(read);
	}
}

/** The plaintext of a note's messages, pulled under the key its link derives. */
function bodyOf(written: { messages: Uint8Array[]; envelope: string; keyFragment: string }) {
	const envelope = fromBase64(written.envelope);
	const parsed = parseEnvelope(envelope);
	if (parsed === undefined) throw new Error("no envelope");
	const key = deriveFormat1Keys(keyFromBase64Url(written.keyFragment.slice(2))).encryptionKey;
	const state = initStreamDecrypt(parsed.streamHeader, key);
	return concatUint8Arrays(
		written.messages.map((message) => decryptChunk(state, message, envelope).decrypted),
	);
}

/** A body laid out by hand around any head: its length, the head, the bytes, then zeros. */
function forgeBody(
	head: unknown,
	bytes: Uint8Array = new Uint8Array(0),
	length = 4096,
): Uint8Array {
	const encoded = encodeRaw(head);
	const body = new Uint8Array(length);
	new DataView(body.buffer).setUint32(0, encoded.length);
	body.set(encoded, 4);
	body.set(bytes, 4 + encoded.length);
	return body;
}

/**
 * A note sealed by hand around any body, under a valid envelope: its messages
 * the last one FINAL, or with the tags given.
 */
function forge(plaintexts: Uint8Array[], fileCount = 0, tags?: number[]) {
	const linkKey = generateKey();
	const { state, header } = initStreamEncrypt(deriveFormat1Keys(linkKey).encryptionKey);
	const envelope = encodeEnvelope({ streamHeader: header, ...settings, fileCount });
	const messages = plaintexts.map((plaintext, i) => {
		const tag = tags?.[i];
		return tag === undefined
			? encryptChunk(state, plaintext, i === plaintexts.length - 1, envelope)
			: sodium.crypto_secretstream_xchacha20poly1305_push(state, plaintext, envelope, tag);
	});
	return { messages, envelope: toBase64(envelope), keyFragment: `1.${keyToBase64Url(linkKey)}` };
}

/** Opens a forged note. */
function openForged(forged: ReturnType<typeof forge>): Promise<NotePayload> {
	return open(forged.messages, forged.envelope, forged.keyFragment);
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

function vectorPayload(payload: {
	readonly text?: string;
	readonly contentMode?: string;
	readonly files?: ReadonlyArray<{ name: string; type: string; size: number; data: string }>;
}): NotePayload {
	return {
		...(payload.text !== undefined ? { text: payload.text } : {}),
		...(payload.contentMode !== undefined
			? { contentMode: payload.contentMode as NotePayload["contentMode"] & string }
			: {}),
		...(payload.files
			? { files: payload.files.map((f) => ({ ...f, data: fromBase64(f.data) })) }
			: {}),
	};
}

const { format1 } = testVectors.vectors;

describe("format 1 fragments", () => {
	test("start with 1. then the key", async () => {
		const { keyFragment } = await write({ text: "x" });
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

	test("refuse every fragment the vectors say a reader must refuse", () => {
		for (const v of format1.invalid.fragments) {
			expect(() => {
				if (formatOfFragment(v.fragment) === 1) assertFormat1Fragment(v.fragment);
			}, v.description).toThrow(SecretValidationError);
		}
	});
});

describe("a format 1 body", () => {
	test("is the head's length, the head, the file bytes, padded to the floor", () => {
		const body = format1BodyOf(withFiles);
		const head = encodeRaw({
			text: "two files",
			contentMode: "markdown",
			files: [
				{ name: "a.bin", type: "application/octet-stream", size: 10 },
				{ name: "empty", type: "application/octet-stream", size: 0 },
			],
		});
		expect(body.parts[0]).toEqual(new Uint8Array([0, 0, 0, head.length]));
		expect(body.parts[1]).toEqual(head);
		// The files' own bytes, not copies: the body is laid out, not built.
		expect(body.parts[2]).toBe(withFiles.files?.[0]?.data);
		expect(body.length).toBe(4096);
	});

	test("is padded to its size class past the floor", () => {
		const data = new Uint8Array(999_000);
		const body = format1BodyOf({ files: [file("b", data)] });
		const head = encodeRaw({
			files: [{ name: "b", type: "application/octet-stream", size: 999_000 }],
		});
		// Past 2^19 bytes, size classes step by 2^14.
		expect(4 + head.length + data.length).toBe(999_000 + 4 + head.length);
		expect(body.length).toBe(61 * 2 ** 14);
	});
});

describe("format 1 notes", () => {
	test("round-trip as one message, padded, under an envelope that says so", async () => {
		const written = await write(withFiles);
		expect(parseEnvelope(fromBase64(written.envelope))).toMatchObject({
			fileCount: 2,
			maxReads: 1,
			expiresIn: 3600,
		});
		expect(parseEnvelope(fromBase64(written.envelope))?.argon2).toBeUndefined();
		expect(written.messages.map((message) => message.length)).toEqual([4096 + 17]);

		const read = await open(written.messages, written.envelope, written.keyFragment);
		expect(read).toEqual(withFiles);
	});

	test("round-trip over messages of one size, a message holding bytes of two files", async () => {
		const payload: NotePayload = {
			files: [file("a", new Uint8Array(3000).fill(1)), file("b", new Uint8Array(1200).fill(2))],
		};
		const written = await write(payload, { messageSize: 1000 });
		expect(written.messages.map((message) => message.length)).toEqual([
			1017,
			1017,
			1017,
			1017,
			352 + 17,
		]);
		await expect(open(written.messages, written.envelope, written.keyFragment)).resolves.toEqual(
			payload,
		);
	});

	test("cut a body that the message size divides into full messages", async () => {
		const written = await write({ text: "t" }, { messageSize: 1024 });
		expect(written.messages.map((message) => message.length)).toEqual([1041, 1041, 1041, 1041]);
		await expect(open(written.messages, written.envelope, written.keyFragment)).resolves.toEqual({
			text: "t",
		});
	});

	test("are one message when the message size exceeds the body", async () => {
		const written = await write({ text: "t" }, { messageSize: 1 << 20 });
		expect(written.messages).toHaveLength(1);
	});

	test.each([0, -1, 1.5, Number.NaN])("refuse a message size of %s", async (messageSize) => {
		await expect(write({ text: "t" }, { messageSize })).rejects.toThrow(
			new SecretValidationError("The message size must be a positive integer"),
		);
	});

	test("leave the payload's bytes as they were, wiping only their copies", async () => {
		const data = new Uint8Array(5000).fill(7);
		await write({ files: [file("a", data)] }, { messageSize: 1000 });
		expect(data.every((byte) => byte === 7)).toBe(true);
	});

	test(
		"round-trip with a password typed in another Unicode form",
		async () => {
			const written = await write({ text: "hi" }, { password: "Pässwörd".normalize("NFC") });
			expect(parseEnvelope(fromBase64(written.envelope))?.argon2).toMatchObject({
				iterations: 3,
				memoryKiB: 262_144,
			});

			const { messages, envelope, keyFragment } = written;
			const nfd = "Pässwörd".normalize("NFD");
			await expect(open(messages, envelope, keyFragment, nfd)).resolves.toEqual({ text: "hi" });
			await expect(open(messages, envelope, keyFragment, "wrong")).rejects.toThrow();
			await expect(open(messages, envelope, keyFragment)).rejects.toThrow(
				"The note requires a password",
			);
		},
		ARGON2_TIMEOUT,
	);

	test("round-trip files without any text", async () => {
		const payload: NotePayload = { files: [file("only.bin", new Uint8Array([5]))] };
		const written = await write(payload);
		await expect(open(written.messages, written.envelope, written.keyFragment)).resolves.toEqual(
			payload,
		);
	});

	test("ignore a password given for a note without one", async () => {
		const written = await write({ text: "hi" });
		await expect(
			open(written.messages, written.envelope, written.keyFragment, "unused"),
		).resolves.toEqual({ text: "hi" });
	});

	test("do not open once a byte of the envelope changed", async () => {
		const written = await write({ text: "hi" });
		const envelope = fromBase64(written.envelope);
		envelope[4] = 0xff; // maxReads
		await expect(open(written.messages, toBase64(envelope), written.keyFragment)).rejects.toThrow();
	});

	test("refuse settings the envelope cannot carry, before stretching the password", async () => {
		const pwhash = vi.spyOn(sodium, "crypto_pwhash");
		const body = format1BodyOf({ text: "hi" });
		try {
			await expect(
				encryptNoteFormat1(body, body.length, { ...settings, maxReads: 70_000 }, "pw"),
			).rejects.toThrow(new SecretValidationError("maxReads must be an integer from 0 to 65535"));
			await expect(
				encryptNoteFormat1(body, 4, { ...settings, expiresIn: -1 }, "pw"),
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
		const written = await write(payload);
		await expect(open(written.messages, written.envelope, written.keyFragment)).resolves.toEqual({
			text: "cut�",
			files: [{ name: "�name", type: "t", size: 0, data: new Uint8Array() }],
		});
	});

	test(
		"hold the payload as the vectors record",
		async () => {
			for (const v of format1.notes) {
				const read = await open(v.messages.map(fromBase64), v.envelope, v.keyFragment, v.password);
				expect(read, v.description).toEqual(vectorPayload(v.payload));
			}
		},
		ARGON2_TIMEOUT,
	);

	// The stream header is random, so the messages differ: their body must not.
	test("are written as the vectors record", async () => {
		for (const v of format1.notes.filter((vector) => !vector.password)) {
			const written = await write(vectorPayload(v.payload), { messageSize: v.messageSize });
			expect(written.messages, v.description).toHaveLength(v.messages.length);
			expect(toBase64(bodyOf(written)), v.description).toBe(v.body);
		}
	});

	test("refuse every note the vectors say a reader must refuse", async () => {
		for (const v of format1.invalid.notes) {
			await expect(
				open(v.messages.map(fromBase64), v.envelope, v.keyFragment),
				v.description,
			).rejects.toThrow();
		}
	});
});

describe("the body of a format 1 note, read strictly", () => {
	const goodFile = { name: "a", type: "t", size: 0 };

	test.each([
		["another extension", new ExtData(5, new Uint8Array([1]))],
		["a nil content mode", { contentMode: null }],
		["nil files", { files: null }],
		["a file without a type", { files: [{ name: "a", size: 0 }] }],
		["a file that is not a map", { files: [[1]] }],
		["a file whose size is a string", { files: [{ ...goodFile, size: "0" }] }],
	])("is refused when its head holds %s", async (_, head) => {
		const files = (head as { files?: unknown }).files;
		const fileCount = Array.isArray(files) ? files.length : 0;
		await expect(openForged(forge([forgeBody(head)], fileCount))).rejects.toThrow(
			"Malformed payload",
		);
	});

	test("may hold 10 files, the most a note holds", async () => {
		const files = Array.from({ length: 10 }, () => goodFile);
		const read = await openForged(forge([forgeBody({ files })], 10));
		expect(read.files).toHaveLength(10);
	});

	test("is rebuilt from its known keys, unknown ones left out", async () => {
		const head = { text: "t", future: 1, files: [{ ...goodFile, extra: 2 }] };
		const read = await openForged(forge([forgeBody(head)], 1));
		expect(read).toEqual({ text: "t", files: [{ ...goodFile, data: new Uint8Array(0) }] });
	});

	test("is refused when shorter than the head's length field", async () => {
		await expect(openForged(forge([new Uint8Array(3)]))).rejects.toThrow("Malformed body");
	});

	test("is refused when the head runs past the body", async () => {
		const body = forgeBody({ text: "t" });
		new DataView(body.buffer).setUint32(0, 4093);
		await expect(openForged(forge([body]))).rejects.toThrow("Malformed body");
	});

	test("is refused when its files run past it", async () => {
		const body = forgeBody({ files: [{ ...goodFile, size: 4096 }] });
		await expect(openForged(forge([body], 1))).rejects.toThrow("does not match the declared size");
	});

	test("must hold as many files as the envelope declares", async () => {
		await expect(openForged(forge([forgeBody({ files: [goodFile] })], 2))).rejects.toThrow(
			"The payload does not hold the files its envelope declares",
		);
	});

	test("is refused padded to another length than its size class", async () => {
		await expect(openForged(forge([forgeBody({ text: "t" }, undefined, 8192)]))).rejects.toThrow(
			"Malformed padding",
		);
		await expect(openForged(forge([forgeBody({ text: "t" }, undefined, 4095)]))).rejects.toThrow(
			"Malformed padding",
		);
	});

	test("is refused when its padding holds a byte other than zero", async () => {
		const body = forgeBody({ text: "t" });
		body[4095] = 1;
		await expect(openForged(forge([body]))).rejects.toThrow("Malformed padding");
	});

	test("comes in at least one message, the last one FINAL and every other MESSAGE", async () => {
		await expect(openForged(forge([]))).rejects.toThrow("No message to open");

		const body = forgeBody({ text: "t" });
		const halves = [body.subarray(0, 2048), body.subarray(2048)];
		const MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
		const FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
		for (const tags of [
			[sodium.crypto_secretstream_xchacha20poly1305_TAG_PUSH, FINAL],
			[sodium.crypto_secretstream_xchacha20poly1305_TAG_REKEY, FINAL],
			[FINAL, FINAL],
			[MESSAGE, MESSAGE],
		]) {
			await expect(openForged(forge(halves, 0, tags)), String(tags)).rejects.toThrow(
				"Encrypted stream is truncated or extended",
			);
		}
		await expect(openForged(forge(halves, 0, [MESSAGE, FINAL]))).resolves.toEqual({ text: "t" });
	});
});

describe("the verifiers a format 1 writer sends", () => {
	test("check the proofs its readers derive, without a password", async () => {
		const written = await write({ text: "hi" });
		expect(written.verifiers.passwordVerifier).toBeUndefined();

		const read = await prepareFormat1Read(written.envelope, written.keyFragment, undefined);
		expect(sha256(fromBase64(read.proofs.linkProof))).toBe(written.verifiers.linkVerifier);
		expect(read.proofs.passwordProof).toBeUndefined();
	});

	test(
		"check both proofs of a password note, and tell a wrong password apart",
		async () => {
			const written = await write({ text: "t" }, { password: "pw", messageSize: 1024 });
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
		const first = await write({ text: "hi" });
		const second = await write({ text: "hi" });
		expect(first.verifiers.linkVerifier).not.toBe(second.verifiers.linkVerifier);
	});
});

describe("preparing a format 1 read", () => {
	test("refuses every envelope the vectors say a reader must refuse", async () => {
		const { keyFragment } = await write({ text: "x" });
		for (const v of format1.invalid.envelopes) {
			await expect(
				prepareFormat1Read(v.envelope, keyFragment, "pw"),
				v.description,
			).rejects.toThrow("Not a format 1 envelope");
		}
	});

	test("refuses a note that sent no envelope, or one a reader refuses", async () => {
		const { keyFragment } = await write({ text: "x" });
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
		const envelope = encodeEnvelope({ streamHeader: generateNonce(), ...settings, argon2 });
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
		const { envelope } = await write({ text: "x" });
		await expect(prepareFormat1Read(envelope, "1.abc", undefined)).rejects.toThrow(
			new SecretValidationError("Invalid key fragment"),
		);
	});

	test(
		"derives the proofs the vectors record",
		async () => {
			for (const v of format1.keys) {
				const argon2 = v.argon2 && { ...v.argon2, salt: fromBase64(v.argon2.salt) };
				const envelope = encodeEnvelope({ streamHeader: generateNonce(), ...settings, argon2 });
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
			const { envelope, keyFragment } = await write({ text: "x" }, { password: "pw" });
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
		["one message", 4096],
		["several messages", 1000],
	])(
		"keeps no secret once a note is written as %s",
		async (_, messageSize) => {
			const secrets = recordSecrets();
			try {
				await write({ text: "x" }, { messageSize, password: "pw" });
				expect(secrets.linkKeys).toHaveLength(1);
				expect(secrets.alive()).toEqual([]);
			} finally {
				secrets.restore();
			}
		},
		ARGON2_TIMEOUT,
	);
});
