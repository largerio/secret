import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `/dev/tty` and the streams over it, faked: the tests run without a terminal.
const device = vi.hoisted(() => ({
	openSync: vi.fn<(path: string, flags: string) => number>(),
	closeSync: vi.fn<(fd: number) => void>(),
	streams: [] as Array<{ kind: string; fd: number; destroyed: boolean }>,
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	openSync: device.openSync,
	closeSync: device.closeSync,
}));

vi.mock("node:tty", async () => {
	const { EventEmitter: Emitter } = await import("node:events");
	class Stream extends Emitter {
		destroyed = false;

		constructor(
			readonly kind: string,
			readonly fd: number,
		) {
			super();
			device.streams.push(this);
		}

		destroy(): void {
			this.destroyed = true;
		}
	}
	class ReadStream extends Stream {
		constructor(fd: number) {
			super("read", fd);
		}

		setRawMode(): this {
			return this;
		}

		setEncoding(): this {
			return this;
		}

		resume(): this {
			return this;
		}

		pause(): this {
			return this;
		}
	}
	class WriteStream extends Stream {
		readonly written: string[] = [];

		constructor(fd: number) {
			super("write", fd);
		}

		write(text: string): boolean {
			this.written.push(text);
			return true;
		}
	}
	return { ReadStream, WriteStream };
});

const { openControllingTerminal } = await import("../terminal.js");

beforeEach(() => {
	device.openSync.mockReset();
	device.closeSync.mockReset();
	device.streams.length = 0;
});

describe("openControllingTerminal", () => {
	it("opens /dev/tty twice, to read and to write, and closes both", async () => {
		device.openSync.mockImplementation((_path, flags) => (flags === "r" ? 10 : 11));
		const terminal = openControllingTerminal();
		expect(device.openSync.mock.calls).toEqual([
			["/dev/tty", "r"],
			["/dev/tty", "w"],
		]);
		expect(device.streams.map(({ kind, fd }) => [kind, fd])).toEqual([
			["read", 10],
			["write", 11],
		]);

		const [input] = device.streams as unknown as [EventEmitter];
		const answer = terminal?.readHidden("Password: ", new AbortController().signal);
		input.emit("data", "secret\r");
		await expect(answer).resolves.toBe("secret");

		terminal?.close();
		expect(device.streams.every((stream) => stream.destroyed)).toBe(true);
	});

	it("answers undefined without a controlling terminal", () => {
		device.openSync.mockImplementation(() => {
			throw Object.assign(new Error("ENXIO"), { code: "ENXIO" });
		});
		expect(openControllingTerminal()).toBeUndefined();
		expect(device.streams).toEqual([]);
	});

	it("closes what it opened when the terminal cannot be written", () => {
		device.openSync.mockImplementation((_path, flags) => {
			if (flags === "w") {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			}
			return 10;
		});
		expect(openControllingTerminal()).toBeUndefined();
		expect(device.closeSync).toHaveBeenCalledWith(10);
	});
});
