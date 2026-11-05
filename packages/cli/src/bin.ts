import { EXIT, SIGNAL_EXIT } from "./errors.js";
import { run } from "./run.js";
import { openControllingTerminal } from "./terminal.js";

const { stdin, stdout, stderr } = process;
const interrupt = new AbortController();
let stoppedWith: number | undefined;
// The first of these signals stops the command and removes its partial files;
// the next one, whichever it is, kills it.
for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT)) {
	process.once(signal, () => {
		stoppedWith = exitCode;
		for (const other of Object.keys(SIGNAL_EXIT)) {
			process.removeAllListeners(other);
		}
		interrupt.abort();
	});
}

const exitCode = await run(process.argv.slice(2), {
	stdin: {
		isTTY: stdin.isTTY === true,
		[Symbol.asyncIterator]: () => stdin[Symbol.asyncIterator](),
	},
	stdout: { isTTY: stdout.isTTY === true, write: (text) => void stdout.write(text) },
	stderr: { isTTY: stderr.isTTY === true, write: (text) => void stderr.write(text) },
	env: process.env,
	cwd: process.cwd(),
	fetch: (input, init) => fetch(input, init),
	signal: interrupt.signal,
	openTerminal: openControllingTerminal,
});
process.exitCode =
	exitCode === EXIT.interrupted && stoppedWith !== undefined ? stoppedWith : exitCode;
