import type { IncomingMessage } from "node:http";

export interface AddressConfig {
	/** Lower-cased header carrying the client address, or "" to use the socket peer. */
	readonly addressHeader: string;
	readonly xffDepth: number;
}

/** Same variables, same meaning as adapter-node's: one setting covers pages and the API. */
export function parseAddressConfig(env: NodeJS.ProcessEnv): AddressConfig {
	return {
		addressHeader: (env["ADDRESS_HEADER"] ?? "").toLowerCase(),
		xffDepth: Number.parseInt(env["XFF_DEPTH"] ?? "1", 10),
	};
}

/**
 * Resolve the requesting client's address the way adapter-node's
 * `getClientAddress` does, but return `undefined` where it would throw.
 *
 * With ADDRESS_HEADER set, the header is legitimately missing on every request
 * that does not come through the reverse proxy, starting with the container
 * health check. Throwing there took production down once: the health check
 * failed, the orchestrator pulled the container and the site 404'd.
 */
export function resolveClientAddress(
	req: IncomingMessage,
	config: AddressConfig,
): string | undefined {
	if (!config.addressHeader) {
		return req.socket.remoteAddress;
	}

	const value = req.headers[config.addressHeader];

	if (typeof value !== "string" || value === "") {
		return undefined;
	}

	if (config.addressHeader !== "x-forwarded-for") {
		return value;
	}

	// X-Forwarded-For is a list the client can prefill: only the entry
	// XFF_DEPTH hops from the right was written by a proxy we trust. A depth
	// that is not a positive integer, or deeper than the list, indexes past
	// either end and lands on undefined.
	const addresses = value.split(",");
	const address = addresses[addresses.length - config.xffDepth]?.trim();

	return address ? address : undefined;
}
