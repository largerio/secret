import { SecretClient } from "@secret/sdk-js";

let clientPromise: Promise<SecretClient> | undefined;

export function getClient(): Promise<SecretClient> {
	if (!clientPromise) {
		clientPromise = SecretClient.create().catch((err: unknown) => {
			clientPromise = undefined;
			throw err;
		});
	}

	return clientPromise;
}
