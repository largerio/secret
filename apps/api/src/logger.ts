export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
	readonly [key: string]: unknown;
}

export interface Logger {
	readonly debug: (msg: string, fields?: LogFields) => void;
	readonly info: (msg: string, fields?: LogFields) => void;
	readonly warn: (msg: string, fields?: LogFields) => void;
	readonly error: (msg: string, fields?: LogFields) => void;
}

// Errors do not JSON.stringify (their properties are non-enumerable), so they
// would silently serialize to {}. The stack is included when present: only the
// error handler ever logs a raw Error, and only under DEBUG.
function toSerializable(value: unknown): unknown {
	if (Error.isError(value)) {
		return {
			name: value.name,
			message: value.message,
			...(value.stack ? { stack: value.stack } : {}),
		};
	}
	return value;
}

/**
 * Minimal structured logger: one JSON object per line, no dependencies.
 * `{"time":"…","level":"info","msg":"…",…fields}` — greppable, and parseable
 * by any log shipper. warn/error go to stderr, the rest to stdout.
 */
export function createLogger(options?: {
	readonly write?: (level: LogLevel, line: string) => void;
	readonly now?: () => Date;
}): Logger {
	const write =
		options?.write ??
		((level: LogLevel, line: string): void => {
			(level === "warn" || level === "error" ? console.error : console.log)(line);
		});
	const now = options?.now ?? ((): Date => new Date());

	const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
		const entry: Record<string, unknown> = { time: now().toISOString(), level, msg };
		for (const [key, value] of Object.entries(fields ?? {})) {
			entry[key] = toSerializable(value);
		}

		let line: string;
		try {
			line = JSON.stringify(entry);
		} catch {
			// Circular or otherwise unserializable fields: a log call must never
			// throw, so keep the envelope and flag the loss.
			line = JSON.stringify({ time: entry["time"], level, msg, serializationError: true });
		}
		write(level, line);
	};

	return {
		debug: (msg, fields) => emit("debug", msg, fields),
		info: (msg, fields) => emit("info", msg, fields),
		warn: (msg, fields) => emit("warn", msg, fields),
		error: (msg, fields) => emit("error", msg, fields),
	};
}

/** Process-wide default logger. Tests observe it by spying on console. */
export const log: Logger = createLogger();
