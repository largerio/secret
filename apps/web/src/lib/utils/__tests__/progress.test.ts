import { describe, expect, it } from "vitest";
import { DONE, readProgress, sendProgress } from "../progress.js";

describe("sendProgress", () => {
	it("shows encryption as an unmeasured first step", () => {
		expect(sendProgress({ phase: "encrypting", phaseProgress: 0.5, overallProgress: 0.1 })).toEqual(
			{
				step: 0,
				percent: null,
				chunk: null,
			},
		);
	});

	it("reports the upload's own progress, not the overall one", () => {
		expect(
			sendProgress({ phase: "uploading", phaseProgress: 0.423, overallProgress: 0.6 }),
		).toEqual({
			step: 1,
			percent: 42,
			chunk: null,
		});
	});

	it("names the chunk under way for a chunked upload", () => {
		const view = sendProgress({
			phase: "uploading",
			phaseProgress: 0.3,
			overallProgress: 0.4,
			currentChunk: 3,
			totalChunks: 8,
		});
		expect(view.chunk).toEqual({ current: 3, total: 8 });
	});

	it("leaves the chunk out when there is only one", () => {
		const view = sendProgress({
			phase: "uploading",
			phaseProgress: 1,
			overallProgress: 1,
			currentChunk: 1,
			totalChunks: 1,
		});
		expect(view.chunk).toBeNull();
	});

	it("holds the upload at 100 % while the server finishes", () => {
		expect(sendProgress({ phase: "processing", phaseProgress: 1, overallProgress: 1 })).toEqual({
			step: 1,
			percent: 100,
			chunk: null,
		});
	});
});

describe("readProgress", () => {
	it("measures the download", () => {
		expect(
			readProgress({
				phase: "downloading",
				phaseProgress: 0.25,
				overallProgress: 0.2,
				currentChunk: 2,
				totalChunks: 4,
			}),
		).toEqual({ step: 0, percent: 25, chunk: { current: 2, total: 4 } });
	});

	it("shows decryption as an unmeasured second step", () => {
		expect(readProgress({ phase: "decrypting", phaseProgress: 0, overallProgress: 0.9 })).toEqual({
			step: 1,
			percent: null,
			chunk: null,
		});
	});
});

describe("DONE", () => {
	it("is the last step, complete", () => {
		expect(DONE).toEqual({ step: 2, percent: 100, chunk: null });
	});
});
