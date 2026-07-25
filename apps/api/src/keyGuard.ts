import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "./db/index.js";
import { meta, notes } from "./db/schema.js";

const FINGERPRINT_ROW = "server_key_fingerprint";

// Domain separator: the stored value is an HMAC over a fixed label rather than
// the key itself, so leaking the fingerprint reveals nothing about the key.
const FINGERPRINT_LABEL = "secret-server-key-fingerprint-v1";

export class ServerKeyMismatchError extends Error {
	readonly hint: string;

	constructor(message: string, hint: string) {
		super(message);
		this.name = "ServerKeyMismatchError";
		this.hint = hint;
	}
}

export function serverKeyFingerprint(serverKey: Buffer): string {
	return createHmac("sha256", serverKey).update(FINGERPRINT_LABEL).digest("hex");
}

/**
 * Refuse to start when SERVER_ENCRYPTION_KEY no longer matches the key that
 * wrote the existing notes.
 *
 * Every note is sealed with a server-side AES-256-GCM layer derived from this
 * key, and it cannot be rotated: swapping it makes every stored note
 * permanently unreadable. Without this check the swap is silent — the process
 * boots, `/api/health` stays green, and every read fails with an opaque 500.
 *
 * The fingerprint is adopted (not enforced) when it is absent, so databases
 * provisioned before this guard existed keep working; and it is overwritten
 * freely while the database holds no notes, so re-pinning a key on a fresh
 * instance stays friction-free.
 *
 * @throws {ServerKeyMismatchError} when the key changed and notes exist, unless
 * `allowChange` is set.
 */
export function assertServerKeyMatches(
	db: AppDatabase,
	serverKey: Buffer,
	options?: { allowChange?: boolean },
): void {
	const fingerprint = serverKeyFingerprint(serverKey);
	const stored = db.select().from(meta).where(eq(meta.key, FINGERPRINT_ROW)).get();

	if (stored === undefined) {
		db.insert(meta).values({ key: FINGERPRINT_ROW, value: fingerprint }).run();
		return;
	}

	if (stored.value === fingerprint) return;

	const hasNotes = db.select({ id: notes.id }).from(notes).limit(1).get() !== undefined;

	if (hasNotes && !options?.allowChange) {
		throw new ServerKeyMismatchError(
			"SERVER_ENCRYPTION_KEY does not match the key this database was created with.",
			[
				"Every existing note is encrypted with the previous key and would become",
				"permanently unreadable. Restore the original key — in the default Docker",
				"setup it is stored in the data volume:",
				"",
				"  docker compose exec app cat /app/data/.encryption_key",
				"",
				"If the data is expendable and you intend to discard every existing note,",
				"start once with ALLOW_SERVER_KEY_CHANGE=true to adopt the new key.",
			].join("\n"),
		);
	}

	if (hasNotes) {
		console.warn(
			"[startup] SERVER_ENCRYPTION_KEY changed and ALLOW_SERVER_KEY_CHANGE is set — existing notes are now unreadable.",
		);
	}

	db.update(meta).set({ value: fingerprint }).where(eq(meta.key, FINGERPRINT_ROW)).run();
}
