import { LocalStorage } from "./local.js";
import { S3Storage } from "./s3.js";
import type { StorageBackend } from "./interface.js";

export type { StorageBackend } from "./interface.js";

export type StorageType = "local" | "s3";

export interface StorageConfig {
	readonly type: StorageType;
	readonly localPath?: string;
	readonly s3?: {
		readonly bucket: string;
		readonly region: string;
		readonly endpoint?: string;
		readonly accessKeyId: string;
		readonly secretAccessKey: string;
		readonly forcePathStyle: boolean;
	};
}

export function createStorageBackend(config: StorageConfig): StorageBackend {
	if (config.type === "s3") {
		if (!config.s3) {
			throw new Error("S3 configuration is required when STORAGE_BACKEND=s3");
		}
		return new S3Storage(config.s3);
	}

	if (!config.localPath) {
		throw new Error("LOCAL path is required when STORAGE_BACKEND=local");
	}
	return new LocalStorage(config.localPath);
}
