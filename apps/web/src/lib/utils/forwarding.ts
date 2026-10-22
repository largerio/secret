/**
 * The visitor's address as SvelteKit resolves it, or undefined where it cannot.
 *
 * adapter-node's `getClientAddress` throws when ADDRESS_HEADER is set and the
 * header is missing, which is the case of every request that skips the reverse
 * proxy (the container health check first). A page must still render then.
 */
export function readClientAddress(getClientAddress: () => string): string | undefined {
	try {
		return getClientAddress();
	} catch {
		return undefined;
	}
}

/**
 * Wrap fetch so every request carries the visitor's address in X-Forwarded-For.
 *
 * Server-side loaders call the API from this process, which the API sees as the
 * peer of every one of their requests. Without the visitor's address, all the
 * page views of the instance would share a single rate-limit bucket.
 */
export function forwardingFetch(clientAddress: string, base: typeof fetch = fetch): typeof fetch {
	return (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("x-forwarded-for", clientAddress);
		return base(input, { ...init, headers });
	};
}
