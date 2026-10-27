import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUSY_TIMEOUT_MS } from "./index.js";
import { getSchemaVersion } from "./migrations.js";

// The API's default too (config.ts).
const DEFAULT_DATABASE_PATH = "./data/secret.db";

const USAGE = [
	"Usage: node apps/api/dist/backup.js <destination>",
	"",
	"Copies the database at DATABASE_PATH (./data/secret.db by default) to",
	"<destination> while the app runs. An existing file is never overwritten.",
].join("\n");

export interface BackupResult {
	readonly source: string;
	readonly destination: string;
	readonly schemaVersion: number;
	readonly bytes: number;
}

function syncToDisk(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * The schema version of a copy that passes SQLite's integrity check.
 *
 * @throws when the check finds a problem, or the file is no database.
 */
export function verifyBackup(path: string): number {
	const copy = new DatabaseSync(path, { readOnly: true });
	try {
		const problems = copy
			.prepare("PRAGMA quick_check")
			.all()
			.map((row) => String(row["quick_check"]));
		if (problems.join() !== "ok") {
			throw new Error(`The copy failed its integrity check: ${problems.join("; ")}`);
		}
		return getSchemaVersion(copy);
	} finally {
		copy.close();
	}
}

/**
 * Copy the database at `source` to `destination`, while the API keeps it open
 * and writes to it.
 *
 * VACUUM INTO reads a single snapshot, in one read transaction: in WAL mode
 * the writer is never blocked, and the copy holds every commit up to the
 * snapshot, those still in the WAL included. It rebuilds the database from its
 * rows, header fields (user_version) included, so nothing deleted reaches the
 * copy: no free page, no slack left in a page, whether or not the connection
 * that deleted had secure_delete on. The online backup API (`backup()` in
 * node:sqlite) copies the pages as they are, and starts over each time another
 * process writes between two of its steps.
 *
 * The copy is written next to `destination`, synced and checked, then renamed
 * into place, so `destination` is either missing or complete. Its owner alone
 * can read it (mode 600): it holds every note's deletion token.
 */
export function backupDatabase(source: string, destination: string): BackupResult {
	const sourcePath = resolve(source);
	const destinationPath = resolve(destination);
	const directory = dirname(destinationPath);

	// Opening a missing file would create an empty database in its place.
	if (!existsSync(sourcePath)) {
		throw new Error(`No database at ${sourcePath}: set DATABASE_PATH to the API's database.`);
	}
	if (existsSync(destinationPath)) {
		throw new Error(`${destinationPath} already exists: a backup never overwrites a file.`);
	}
	if (!existsSync(directory)) {
		throw new Error(`No directory ${directory} to write the backup in.`);
	}

	// Named per run: what a killed run left behind cannot get in the way.
	const partialPath = `${destinationPath}.${randomBytes(4).toString("hex")}.partial`;
	// VACUUM INTO writes into an empty file, keeping its mode, and gives its
	// journal the same one. Created before the try: a name already taken is
	// not ours to remove.
	closeSync(openSync(partialPath, "wx", 0o600));
	try {
		// Read-write, though it writes nothing: with the app stopped, closing
		// the last connection removes the -wal and -shm files opening created.
		const database = new DatabaseSync(sourcePath);
		try {
			database.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
			database.exec("PRAGMA temp_store = MEMORY");
			database.prepare("VACUUM INTO ?").run(partialPath);
		} finally {
			database.close();
		}

		// VACUUM INTO leaves what it wrote unsynced.
		syncToDisk(partialPath);
		const schemaVersion = verifyBackup(partialPath);
		renameSync(partialPath, destinationPath);
		syncToDisk(directory);

		return {
			source: sourcePath,
			destination: destinationPath,
			schemaVersion,
			bytes: statSync(destinationPath).size,
		};
	} catch (err) {
		rmSync(partialPath, { force: true });
		// A copy that fills the disk leaves its journal behind too.
		rmSync(`${partialPath}-journal`, { force: true });
		throw err;
	}
}

/** `backup.js <destination>`. Returns the exit code. */
export function runBackupCommand(
	args: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): number {
	const [destination, ...rest] = args;
	if (destination === "--help" || destination === "-h") {
		console.log(USAGE);
		return 0;
	}
	if (destination === undefined || destination.startsWith("-") || rest.length > 0) {
		console.error(USAGE);
		return 2;
	}

	try {
		const result = backupDatabase(env["DATABASE_PATH"] ?? DEFAULT_DATABASE_PATH, destination);
		console.log(
			`Backed up ${result.source} to ${result.destination} (schema version ${String(result.schemaVersion)}, ${String(result.bytes)} bytes).`,
		);
		return 0;
	} catch (err: unknown) {
		// Node and SQLite only throw Errors here.
		console.error(`Backup failed: ${(err as Error).message}`);
		return 1;
	}
}
