export interface ProofOfWorkOptions {
	readonly fetch: typeof fetch;
	readonly signal?: AbortSignal;
	/** Called each time one of the instance's challenges is solved. */
	readonly onProgress?: (solved: number, total: number) => void;
}

/**
 * Solves the instance's proof-of-work challenge and returns the single-use
 * write token it redeems for (`X-Cap-Token`).
 */
export async function solveProofOfWork(
	_baseUrl: string,
	_options: ProofOfWorkOptions,
): Promise<string> {
	throw new Error("not implemented");
}
