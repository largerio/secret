import { OpenAPIHono } from "@hono/zod-openapi";
import type { NotesService } from "../../notes/service.js";
import { registerReadRoutes } from "./reads.js";
import { registerWriteRoutes } from "./writes.js";

/**
 * The notes API over the service: each route validates its request against
 * its OpenAPI schema, calls the service and shapes the answer. A refusal of
 * the service reaches the app's error handler, which maps it (errorStatus.ts).
 */
export function createNotesRoutes(notes: NotesService) {
	const app = new OpenAPIHono({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid request" }, 400);
			}
		},
	});

	registerWriteRoutes(app, notes);
	registerReadRoutes(app, notes);

	return app;
}
