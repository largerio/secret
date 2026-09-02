import { createNodeIo } from "./io.js";
import { run } from "./main.js";

const io = createNodeIo({
	stdin: process.stdin,
	stdout: process.stdout,
	stderr: process.stderr,
	env: process.env,
});

// `exitCode` rather than `process.exit()`: stdout may still be flushing when a
// large note has just been printed to a pipe.
process.exitCode = await run(process.argv.slice(2), io);
