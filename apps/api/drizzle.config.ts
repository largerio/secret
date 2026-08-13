import { defineConfig } from "drizzle-kit";

// Used by `pnpm db:generate` to diff src/db/schema.ts against the snapshot in
// ./drizzle and emit the migration SQL there. The SQL is then embedded into
// src/db/migrations.ts (see the workflow comment at the top of that file) —
// nothing under ./drizzle is read at runtime.
export default defineConfig({
	dialect: "sqlite",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
});
