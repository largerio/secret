import { OpenAPIHono } from "@hono/zod-openapi";
import { registerChunkedRoutes } from "./chunked.js";
import type { NotesEnv } from "./helpers.js";
import { registerStandardRoutes } from "./standard.js";

export function createNotesRoutes() {
	const app = new OpenAPIHono<NotesEnv>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid request" }, 400);
			}
		},
	});

	// Registration order matters: standard routes first, then chunked routes,
	// preserving the original top-to-bottom order so middleware (validateUploadId)
	// stays registered before the handlers it guards and static `/upload/*` paths
	// keep priority over the `/:id` param routes.
	registerStandardRoutes(app);
	registerChunkedRoutes(app);

	return app;
}
