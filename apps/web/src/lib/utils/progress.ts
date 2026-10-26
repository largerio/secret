import type { ProgressInfo } from "@largerio/secret-sdk";

/** What the progress panel shows: one of three steps, how far it is, and the chunk under way. */
export interface ProgressView {
	/** 0 = encrypting / downloading, 1 = uploading / decrypting, 2 = done. */
	readonly step: 0 | 1 | 2;
	/** Percent of the current step, or null while it cannot be measured. */
	readonly percent: number | null;
	readonly chunk: { readonly current: number; readonly total: number } | null;
}

export const DONE: ProgressView = { step: 2, percent: 100, chunk: null };

function chunkOf(info: ProgressInfo): ProgressView["chunk"] {
	const { currentChunk, totalChunks } = info;
	return currentChunk && totalChunks && totalChunks > 1
		? { current: currentChunk, total: totalChunks }
		: null;
}

const percentOf = (info: ProgressInfo) => Math.round(info.phaseProgress * 100);

/**
 * Creating a note: encryption runs in one go and cannot report progress, the
 * upload can. "processing" is the server finishing up after the last byte.
 */
export function sendProgress(info: ProgressInfo): ProgressView {
	if (info.phase === "encrypting") return { step: 0, percent: null, chunk: null };
	if (info.phase === "processing") return { step: 1, percent: 100, chunk: null };
	return { step: 1, percent: percentOf(info), chunk: chunkOf(info) };
}

/** Opening a note: the download reports progress, decryption runs in one go. */
export function readProgress(info: ProgressInfo): ProgressView {
	if (info.phase === "downloading") {
		return { step: 0, percent: percentOf(info), chunk: chunkOf(info) };
	}
	return { step: 1, percent: null, chunk: null };
}
