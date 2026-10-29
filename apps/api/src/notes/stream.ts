// Chunk loads kept in flight while a stream is served, so that per-chunk
// storage latency (one round-trip per chunk on S3) overlaps with delivery
// instead of adding up.
const PREFETCH_CHUNKS = 4;

/**
 * A chunked note's chunks, in order, from a source that loads and opens each.
 *
 * Backpressure: delivery happens in pull(), which the runtime only invokes
 * while the queue has room, so a slow client suspends storage reads instead of
 * accumulating the note in memory: at most the read-ahead window is in flight.
 */
export function chunkStream(source: {
	readonly count: number;
	/** The first chunk, loaded and opened before the read was spent. */
	readonly first: Buffer;
	/** Loads and opens one chunk after the first. */
	readonly load: (index: number) => Promise<Buffer>;
	/** Runs once, whether the stream completes, fails or is cancelled. */
	readonly onEnd: () => Promise<void>;
}): ReadableStream<Uint8Array> {
	// Rejections are captured as values, so an un-awaited prefetch can never
	// surface as an unhandled rejection.
	type Loaded =
		| { readonly ok: true; readonly chunk: Buffer }
		| { readonly ok: false; readonly reason: unknown };
	const loadSafely = (index: number): Promise<Loaded> =>
		(index === 0 ? Promise.resolve(source.first) : source.load(index)).then(
			(chunk) => ({ ok: true as const, chunk }),
			(reason: unknown) => ({ ok: false as const, reason }),
		);

	const readAhead: Promise<Loaded>[] = [];
	let nextToLoad = 0;
	let delivered = 0;

	// cancel() can race a pull() still awaiting a load, hence the flag.
	let ended = false;
	const endOnce = async (): Promise<void> => {
		if (ended) return;
		ended = true;
		await source.onEnd();
	};

	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					while (nextToLoad < source.count && readAhead.length < PREFETCH_CHUNKS) {
						readAhead.push(loadSafely(nextToLoad));
						nextToLoad += 1;
					}

					// Never empty: pull() stops being called once the last chunk is out.
					const loaded = await (readAhead.shift() as Promise<Loaded>);
					if (!loaded.ok) {
						controller.error(loaded.reason);
						await endOnce();
						return;
					}

					controller.enqueue(new Uint8Array(loaded.chunk));
					delivered += 1;
					if (delivered === source.count) {
						controller.close();
						await endOnce();
					}
				} catch (err) {
					// A chunk arriving after a cancel cannot be enqueued, for one.
					controller.error(err);
					await endOnce();
				}
			},
			async cancel() {
				await endOnce();
			},
		},
		// Nothing queued ahead of the reader: the read-ahead window is the bound.
		{ highWaterMark: 0 },
	);
}
