import type { SecretClient } from "@largerio/sdk-js";

let clientPromise: Promise<SecretClient> | undefined;

export function getClient(): Promise<SecretClient> {
	if (!clientPromise) {
		// Dynamic import keeps the SDK + libsodium WASM out of the initial bundle.
		// They're only needed once the user actually creates or reads a note.
		clientPromise = import("@largerio/sdk-js")
			.then((mod) => mod.SecretClient.create())
			.catch((err: unknown) => {
				clientPromise = undefined;
				throw err;
			});
	}

	return clientPromise;
}
