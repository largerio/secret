import { describe, expect, it, vi } from "vitest";
import { createLogger, type LogLevel } from "../logger.js";

function captureLogger() {
	const lines: Array<{ level: LogLevel; entry: Record<string, unknown> }> = [];
	const logger = createLogger({
		write: (level, line) => {
			lines.push({ level, entry: JSON.parse(line) as Record<string, unknown> });
		},
		now: () => new Date("2026-01-02T03:04:05.000Z"),
	});
	return { logger, lines };
}

describe("createLogger", () => {
	it("emits one JSON object per line with time, level, msg and fields", () => {
		const { logger, lines } = captureLogger();

		logger.info("note created", { noteId: "abc", sizeBytes: 42 });

		expect(lines).toEqual([
			{
				level: "info",
				entry: {
					time: "2026-01-02T03:04:05.000Z",
					level: "info",
					msg: "note created",
					noteId: "abc",
					sizeBytes: 42,
				},
			},
		]);
	});

	it("supports all four levels", () => {
		const { logger, lines } = captureLogger();

		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");

		expect(lines.map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
	});

	it("routes warn/error to stderr and the rest to stdout by default", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const logger = createLogger();
		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");

		expect(logSpy).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenCalledTimes(2);
		expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({ level: "debug" });
		expect(JSON.parse(errorSpy.mock.calls[1]?.[0] as string)).toMatchObject({ level: "error" });

		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("serializes Error fields to name/message/stack", () => {
		const { logger, lines } = captureLogger();

		logger.error("failed", { error: new RangeError("out of range") });

		const serialized = lines[0]?.entry["error"] as { stack?: string };
		expect(serialized).toMatchObject({
			name: "RangeError",
			message: "out of range",
		});
		expect(serialized.stack).toBeDefined();
	});

	it("omits the stack when an Error has none", () => {
		const { logger, lines } = captureLogger();
		const bare = new Error("no trace");
		delete (bare as { stack?: string }).stack;

		logger.error("failed", { error: bare });

		expect(lines[0]?.entry["error"]).toEqual({ name: "Error", message: "no trace" });
	});

	it("never throws on unserializable fields", () => {
		const { logger, lines } = captureLogger();
		const circular: { self?: unknown } = {};
		circular.self = circular;

		logger.info("looped", { circular });

		expect(lines[0]?.entry).toEqual({
			time: "2026-01-02T03:04:05.000Z",
			level: "info",
			msg: "looped",
			serializationError: true,
		});
	});
});
