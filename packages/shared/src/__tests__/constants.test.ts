import { describe, expect, it } from "vitest";
import {
	CLEANUP_INTERVAL_MS,
	DEFAULT_EXPIRY_SECONDS,
	MAX_EXPIRY_SECONDS,
	MAX_FILE_SIZE,
	MAX_FILES_PER_NOTE,
	MAX_TEXT_SIZE,
	MIN_EXPIRY_SECONDS,
	NOTE_ID_LENGTH,
	S3_MAX_FILE_SIZE,
} from "../constants.js";

describe("constants", () => {
	it("has correct MAX_TEXT_SIZE (100KB)", () => {
		expect(MAX_TEXT_SIZE).toBe(102_400);
	});

	it("has correct MAX_FILE_SIZE (10MB)", () => {
		expect(MAX_FILE_SIZE).toBe(10_485_760);
	});

	it("has correct MAX_FILES_PER_NOTE", () => {
		expect(MAX_FILES_PER_NOTE).toBe(10);
	});

	it("has correct DEFAULT_EXPIRY_SECONDS (24h)", () => {
		expect(DEFAULT_EXPIRY_SECONDS).toBe(86_400);
	});

	it("has correct MAX_EXPIRY_SECONDS (30 days)", () => {
		expect(MAX_EXPIRY_SECONDS).toBe(2_592_000);
	});

	it("has correct MIN_EXPIRY_SECONDS (5 minutes)", () => {
		expect(MIN_EXPIRY_SECONDS).toBe(300);
	});

	it("has correct NOTE_ID_LENGTH", () => {
		expect(NOTE_ID_LENGTH).toBe(12);
	});

	it("has correct CLEANUP_INTERVAL_MS (5 minutes)", () => {
		expect(CLEANUP_INTERVAL_MS).toBe(300_000);
	});

	it("MIN_EXPIRY is less than MAX_EXPIRY", () => {
		expect(MIN_EXPIRY_SECONDS).toBeLessThan(MAX_EXPIRY_SECONDS);
	});

	it("DEFAULT_EXPIRY is within valid range", () => {
		expect(DEFAULT_EXPIRY_SECONDS).toBeGreaterThanOrEqual(MIN_EXPIRY_SECONDS);
		expect(DEFAULT_EXPIRY_SECONDS).toBeLessThanOrEqual(MAX_EXPIRY_SECONDS);
	});

	it("has correct S3_MAX_FILE_SIZE (100MB)", () => {
		expect(S3_MAX_FILE_SIZE).toBe(104_857_600);
	});

	it("S3_MAX_FILE_SIZE is greater than MAX_FILE_SIZE", () => {
		expect(S3_MAX_FILE_SIZE).toBeGreaterThan(MAX_FILE_SIZE);
	});
});
