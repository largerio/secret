import { defineEnvVars } from "@sveltejs/kit/env";

/**
 * SvelteKit 3 only exposes the variables declared here (through
 * `$app/env/private`); `$env/dynamic/private` no longer hands out the whole
 * process environment.
 *
 * Without a schema a declared variable is mandatory and the server refuses to
 * start when it is unset. Every one of these has a sensible default applied
 * where it is read (`lib/server/env.ts`, `lib/server-config.ts`), and a fresh
 * instance must boot with zero configuration, so each schema accepts
 * `undefined` and passes the raw value through untouched.
 */
const optional = (value: string | undefined): string | undefined => value;

export const variables = defineEnvVars({
	API_URL: { schema: optional },
	APP_URL: { schema: optional },
	APP_NAME: { schema: optional },
	APP_DESCRIPTION: { schema: optional },
	APP_PRIMARY_COLOR: { schema: optional },
	APP_FOOTER_TEXT: { schema: optional },
	APP_OG_IMAGE_URL: { schema: optional },
	MAX_FILE_SIZE: { schema: optional },
	MAX_FILES_PER_NOTE: { schema: optional },
	CHUNK_SIZE: { schema: optional },
	MAX_CHUNKED_FILE_SIZE: { schema: optional },
	MAX_EXPIRY: { schema: optional },
});
