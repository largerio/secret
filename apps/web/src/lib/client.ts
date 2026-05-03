import type { SecretClient } from "@secret/sdk-js";

let clientPromise: Promise<SecretClient> | undefined;

export function getClient(): Promise<SecretClient> {
	if (!clientPromise) {
		// Dynamic import keeps the SDK + libsodium WASM out of the initial bundle.
		// They're only needed once the user actually creates or reads a note.
		clientPromise = import("@secret/sdk-js")
			.then((mod) => mod.SecretClient.create())
			.catch((err: unknown) => {
				clientPromise = undefined;
				throw err;
			});
	}

	return clientPromise;
}
