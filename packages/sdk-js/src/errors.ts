export class SecretApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SecretApiError";
		this.status = status;
	}
}

export class SecretDecryptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecretDecryptionError";
	}
}
