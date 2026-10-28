import type { Context, MiddlewareHandler } from "hono";

function carriesBody(c: Context): boolean {
	const length = c.req.header("content-length");
	return (
		(length !== undefined && length !== "0") || c.req.header("transfer-encoding") !== undefined
	);
}

/**
 * Closes the connection after an error answered to a request with a body.
 *
 * Such an error (a body or rate limit, a refused write) often comes before
 * the body is read. The server then drains the rest of it for 500 ms
 * (@hono/node-server) and drops a connection it had announced as kept alive:
 * a request the client sent on it meanwhile was lost, as a network error.
 * `Connection: close` has the client open a new one instead. Errors are
 * rare, so the extra handshake costs nothing.
 */
export function createCloseAfterError(): MiddlewareHandler {
	return async (c, next) => {
		await next();
		if (c.res.status >= 400 && carriesBody(c)) {
			c.header("Connection", "close");
		}
	};
}
