import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINGER_MS, lingerOnClose } from "../linger.js";

// The connections themselves are tested where they matter, behind the web
// server's proxy (apps/web/src/server/__tests__/server.test.ts).
afterEach(() => {
	vi.useRealTimers();
});

describe("lingerOnClose", () => {
	/** A socket as destroySoon sees it, driven by hand. */
	function fakeSocket(state: {
		writable: boolean;
		readableEnded: boolean;
		writableFinished: boolean;
	}) {
		const socket = Object.assign(new EventEmitter(), state, {
			end: vi.fn(),
			destroy: vi.fn(),
			resume: vi.fn(),
		});
		const server = new EventEmitter() as unknown as Server;
		lingerOnClose(server, 50);
		server.emit("connection", socket);
		return socket as typeof socket & Pick<Socket, "destroySoon">;
	}

	it("ends the answer, reads on, and closes once the client has closed its side", () => {
		const socket = fakeSocket({ writable: true, readableEnded: false, writableFinished: true });

		socket.destroySoon();
		expect(socket.end).toHaveBeenCalledOnce();
		expect(socket.resume).toHaveBeenCalledOnce();
		expect(socket.destroy).not.toHaveBeenCalled();

		socket.emit("end");
		expect(socket.destroy).toHaveBeenCalledOnce();
	});

	it("closes after the delay a client that keeps sending", () => {
		vi.useFakeTimers();
		const socket = fakeSocket({ writable: true, readableEnded: false, writableFinished: true });

		socket.destroySoon();
		vi.advanceTimersByTime(49);
		expect(socket.destroy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(socket.destroy).toHaveBeenCalledOnce();
	});

	it("waits for the answer to be flushed before closing", () => {
		const socket = fakeSocket({ writable: false, readableEnded: true, writableFinished: false });

		socket.destroySoon();
		expect(socket.end).not.toHaveBeenCalled();
		expect(socket.destroy).not.toHaveBeenCalled();

		socket.emit("finish");
		expect(socket.destroy).toHaveBeenCalledOnce();
	});

	it("drops its delay once the socket is closed", () => {
		vi.useFakeTimers();
		const socket = fakeSocket({ writable: true, readableEnded: false, writableFinished: true });

		socket.destroySoon();
		socket.emit("close");
		vi.advanceTimersByTime(LINGER_MS);
		expect(socket.destroy).not.toHaveBeenCalled();
	});
});
