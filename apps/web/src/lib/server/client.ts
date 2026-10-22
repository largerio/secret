import { SecretClient } from "@largerio/secret-sdk";
import { forwardingFetch } from "#lib/utils/forwarding.js";
import { API_TARGET } from "./env";

/**
 * An SDK client for server-side loaders, speaking for one visitor.
 *
 * One client per request, since the visitor's address goes in every request it
 * makes. Cheap: the SDK initialises libsodium once per process.
 */
export function getServerClient(clientAddress: string | undefined): Promise<SecretClient> {
	return SecretClient.create({
		baseUrl: API_TARGET,
		...(clientAddress ? { fetch: forwardingFetch(clientAddress) } : {}),
	});
}
