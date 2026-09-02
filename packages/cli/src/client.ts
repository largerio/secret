import { SecretClient } from "@largerio/secret-sdk";

/**
 * The only place a client is built. Everything cryptographic and every HTTP
 * request lives in the SDK; the CLI parses arguments and moves bytes between
 * the terminal, the filesystem and `SecretClient`.
 */
export function createClient(serverUrl: string, apiKey?: string): Promise<SecretClient> {
	return SecretClient.create({
		baseUrl: serverUrl,
		...(apiKey !== undefined ? { apiKey } : {}),
	});
}
