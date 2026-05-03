export async function runWithConcurrency<T>(
	items: ReadonlyArray<T>,
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			await worker(items[cursor++] as T);
		}
	});
	await Promise.all(runners);
}
