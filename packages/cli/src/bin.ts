import { run } from "./run.js";
import { openControllingTerminal } from "./terminal.js";

const { stdin, stdout, stderr } = process;
const interrupt = new AbortController();
// The first Ctrl-C stops the command and cleans up; a second one kills it.
process.once("SIGINT", () => interrupt.abort());

process.exitCode = await run(process.argv.slice(2), {
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
