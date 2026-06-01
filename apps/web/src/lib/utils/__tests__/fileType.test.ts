import { describe, expect, it } from "vitest";
import { getFileCategory, isPreviewable } from "../fileType.js";

describe("getFileCategory", () => {
	it("categorizes image MIME types", () => {
		expect(getFileCategory("image/png")).toBe("image");
		expect(getFileCategory("image/jpeg")).toBe("image");
		expect(getFileCategory("image/svg+xml")).toBe("image");
	});

	it("categorizes video MIME types", () => {
		expect(getFileCategory("video/mp4")).toBe("video");
		expect(getFileCategory("video/webm")).toBe("video");
	});

	it("categorizes audio MIME types", () => {
		expect(getFileCategory("audio/mpeg")).toBe("audio");
		expect(getFileCategory("audio/ogg")).toBe("audio");
	});

	it("categorizes PDF", () => {
		expect(getFileCategory("application/pdf")).toBe("pdf");
	});

	it("categorizes everything else as other", () => {
		expect(getFileCategory("application/zip")).toBe("other");
		expect(getFileCategory("text/plain")).toBe("other");
		expect(getFileCategory("application/octet-stream")).toBe("other");
		expect(getFileCategory("")).toBe("other");
	});
});

describe("isPreviewable", () => {
	it("returns true for previewable types", () => {
		expect(isPreviewable("image/png")).toBe(true);
		expect(isPreviewable("video/mp4")).toBe(true);
		expect(isPreviewable("audio/mpeg")).toBe(true);
		expect(isPreviewable("application/pdf")).toBe(true);
	});

	it("returns false for non-previewable types", () => {
		expect(isPreviewable("application/zip")).toBe(false);
		expect(isPreviewable("text/plain")).toBe(false);
		expect(isPreviewable("")).toBe(false);
	});
});
