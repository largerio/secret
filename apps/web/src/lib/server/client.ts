import { SecretClient } from "@largerio/secret-sdk";
import { API_TARGET } from "./env";

let clientPromise: Promise<SecretClient> | undefined;

export function getServerClient(): Promise<SecretClient> {
	if (!clientPromise) {
		clientPromise = SecretClient.create({ baseUrl: API_TARGET }).catch((err: unknown) => {
			clientPromise = undefined;
			throw err;
		});
	}
	return clientPromise;
}
