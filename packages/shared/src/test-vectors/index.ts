import vectors from "./vectors.json" with { type: "json" };

export interface XChaCha20Vector {
	readonly description: string;
	readonly key: string;
	readonly nonce: string;
	readonly plaintext: string;
	readonly ciphertext: string;
}

export interface Argon2idVector {
	readonly description: string;
	readonly password: string;
	readonly salt: string;
	readonly baseKey: string;
	readonly baseKeyUrl: string;
	readonly combinedInput: string;
	readonly opsLimit: number;
	readonly memLimit: number;
	readonly algorithm: string;
	readonly derivedKey: string;
}

export interface PipelineFileVector {
	readonly name: string;
	readonly type: string;
	readonly size: number;
	readonly data: string;
}

export interface PipelineVector {
	readonly description: string;
	readonly payload: {
		readonly text: string;
		readonly contentMode: string;
		readonly files?: ReadonlyArray<PipelineFileVector>;
	};
	readonly payloadMsgpack: string;
	readonly key: string;
	readonly nonce: string;
	readonly ciphertext: string;
}

export interface EncodingVector {
	readonly description: string;
	readonly raw: string;
	readonly base64url: string;
}

export interface TestVectors {
	readonly version: number;
	readonly generatedWith: string;
	readonly vectors: {
		readonly xchacha20poly1305: ReadonlyArray<XChaCha20Vector>;
		readonly argon2id: ReadonlyArray<Argon2idVector>;
		readonly pipeline: ReadonlyArray<PipelineVector>;
		readonly encoding: ReadonlyArray<EncodingVector>;
	};
}

export const testVectors: TestVectors = vectors as TestVectors;
