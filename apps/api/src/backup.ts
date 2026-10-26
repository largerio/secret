import { runBackupCommand } from "./db/backup.js";

// `node apps/api/dist/backup.js <destination>`: a consistent copy of the
// database while the app runs. See "Backup & restore" in docs/self-hosting.md.
process.exitCode = runBackupCommand(process.argv.slice(2), process.env);
