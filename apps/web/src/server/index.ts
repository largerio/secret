import { createServer } from "node:http";
import process from "node:process";
import { parseAddressConfig } from "./clientAddress.js";
import { createRequestListener, parseApiTarget, type SvelteKitHandler } from "./server.js";

// Written by adapter-node at build time. A computed specifier keeps the
// typechecker from resolving a file that only exists after `vite build`.
const handlerModule = new URL("../../build/handler.js", import.meta.url).href;
const { handler } = (await import(handlerModule)) as { handler: SvelteKitHandler };

const server = createServer(
	createRequestListener({
		handler,
		apiTarget: parseApiTarget(process.env["API_URL"]),
		address: parseAddressConfig(process.env),
	}),
);

const host = process.env["HOST"] ?? "0.0.0.0";
const port = Number.parseInt(process.env["PORT"] ?? "3000", 10);
const shutdownTimeout = Number.parseInt(process.env["SHUTDOWN_TIMEOUT"] ?? "30", 10);

server.listen(port, host, () => {
	console.log(`Listening on http://${host}:${port}`);
});

// Same contract as adapter-node's own server: stop accepting connections, let
// in-flight requests finish, and force-close whatever is left after
// SHUTDOWN_TIMEOUT seconds.
let shuttingDown = false;

function shutdown(): void {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;
	server.close();
	server.closeIdleConnections();
	setTimeout(() => server.closeAllConnections(), shutdownTimeout * 1000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
