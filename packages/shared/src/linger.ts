import type { Server } from "node:http";
import type { Socket } from "node:net";

/** How long a connection closing after its answer is still read, at most. */
export const LINGER_MS = 2000;

/**
 * Lingering close (RFC 9112, section 9.6), for the API and the web server.
 *
 * A server that answers a request before reading all of its body (a refused
 * write, a body too large) closes the connection: Node calls
 * `socket.destroySoon()`, which closes the socket as soon as the answer is
 * sent. The client is still sending, and what it sends to a closed socket
 * draws a reset, which can make its system throw the answer away before the
 * client reads it: the refusal turned into a network error, or a 502 behind
 * the web server's proxy.
 *
 * On every connection of `server`, closing now ends the answer, keeps reading
 * and discarding what still arrives, and closes once the client has closed its
 * side, or after `lingerMs`.
 */
export function lingerOnClose(server: Server, lingerMs = LINGER_MS): void {
	server.on("connection", (socket: Socket) => {
		socket.destroySoon = function lingeringDestroySoon(this: Socket): void {
			if (this.writable) {
				this.end();
			}
			// Destroyed before the answer is flushed, the socket would drop it.
			const close = () => {
				clearTimeout(timer);
				if (this.writableFinished) {
					this.destroy();
				} else {
					this.once("finish", () => this.destroy());
				}
			};
			const timer = setTimeout(close, lingerMs);
			timer.unref();
			this.once("close", () => clearTimeout(timer));
			if (this.readableEnded) {
				close();
				return;
			}
			this.once("end", close);
			this.resume();
		};
	});
}
