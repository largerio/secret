import { runBackupCommand } from "./db/backup.js";

// `node apps/api/dist/backup.js <destination>`: a consistent copy of the
// database while the app runs. See "Backup & restore" in docs/self-hosting.md.

// Killed by a signal, the process would leave a partial copy and its journal
// next to the destination. With a listener, the signal waits for the event
// loop, which the command never yields to: the copy runs to its end, or fails
// and cleans up after itself, and the process exits with the command's code.
// That code says whether the destination holds a checked copy, which a signal
// cannot change.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => {});
}

process.exitCode = runBackupCommand(process.argv.slice(2), process.env);
