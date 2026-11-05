import { closeSync, openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import type { ProgressInfo } from "@largerio/secret-sdk";
import { CliError, EXIT } from "./errors.js";
import type { OutputStream, Terminal } from "./types.js";

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const TAB = 0x09;
const DEL = 0x7f;
/** U+2400, SYMBOL FOR NULL: the C0 controls have pictures from there on. */
const CONTROL_PICTURES = 0x2400;

/**
 * A format character, invisible, but the zero-width joiners (ZWNJ, ZWJ),
 * which scripts and emoji need. The bidirectional ones among them reorder how
 * a text reads: `invoice\u202Efdp.exe` shows as `invoiceexe.pdf`. A pattern,
 * for the regular expressions of what a terminal or a file name may not hold.
 */
export const FORMAT_CHARACTER = String.raw`(?![\u200C\u200D])\p{Cf}`;

/** What a terminal would run or hide rather than show: the controls, and the format characters. */
const UNSAFE_ON_TERMINAL = new RegExp(String.raw`\p{Cc}|${FORMAT_CHARACTER}`, "gu");
/** What JSON writes as it is, but a terminal would run or hide: DEL, C1, and the format characters. */
const UNSAFE_IN_JSON = new RegExp(String.raw`[\u007F-\u009F]|${FORMAT_CHARACTER}`, "gu");

/**
 * Makes text safe to show on a terminal, so that a note, a file name or an
 * instance's answer cannot drive it, nor read otherwise than it is: the C0
 * controls but line feed and tab become their pictures (ESC is ␛), DEL
 * becomes ␡, the C1 controls and the format characters U+FFFD. A carriage
 * return before a line feed, a Windows line ending, is dropped.
 */
export function sanitize(text: string): string {
	return text.replace(UNSAFE_ON_TERMINAL, (char: string, offset: number) => {
		const code = char.charCodeAt(0);
		if (code === LINE_FEED || code === TAB) {
			return char;
		}
		if (code === CARRIAGE_RETURN && text.charCodeAt(offset + 1) === LINE_FEED) {
			return "";
		}
		if (code < 0x20) {
			return String.fromCharCode(CONTROL_PICTURES + code);
		}
		return code === DEL ? "\u2421" : "\uFFFD";
	});
}

/** Writes a line, made safe first when the stream is a terminal. */
export function writeLine(stream: OutputStream, text: string): void {
	stream.write(`${stream.isTTY ? sanitize(text) : text}\n`);
}

/**
 * Writes a note's text as it is, or, on a terminal, made safe and ending with
 * a line break.
 */
export function writeText(stream: OutputStream, text: string): void {
	if (!stream.isTTY) {
		stream.write(text);
		return;
	}
	const safe = sanitize(text);
	stream.write(safe === "" || safe.endsWith("\n") ? safe : `${safe}\n`);
}

/**
 * Writes one JSON value on a line. JSON escapes the C0 controls but leaves
 * DEL, C1 and the format characters as they are: on a terminal, they are
 * escaped too, which keeps the same value.
 */
export function writeJson(stream: OutputStream, value: unknown): void {
	const json = JSON.stringify(value);
	if (!stream.isTTY) {
		stream.write(`${json}\n`);
		return;
	}
	// Each UTF-16 unit, a character beyond the BMP as its two surrogates.
	const escaped = json.replace(UNSAFE_IN_JSON, (char: string) =>
		Array.from(
			{ length: char.length },
			(_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`,
		).join(""),
	);
	stream.write(`${escaped}\n`);
}

/** What a command tells on stderr besides its result. */
export interface Screen {
	/** A line of information, unless `--quiet`. */
	info(text: string): void;
	/**
	 * Where a long step is: one line, rewritten in place, shown only when
	 * stderr is a terminal, and not with `--quiet`.
	 */
	progress(text: string): void;
	/** Erases the progress line. */
	done(): void;
}

export function createScreen(stderr: OutputStream, quiet: boolean): Screen {
	const showsProgress = stderr.isTTY && !quiet;
	let shown = "";
	const done = (): void => {
		if (shown !== "") {
			stderr.write("\r\u001b[K");
			shown = "";
		}
	};
	return {
		info: (text) => {
			if (quiet) {
				return;
			}
			done();
			writeLine(stderr, text);
		},
		progress: (text) => {
			if (!showsProgress || text === shown) {
				return;
			}
			stderr.write(`\r\u001b[K${text}`);
			shown = text;
		},
		done,
	};
}

const PHASES: Record<ProgressInfo["phase"], string> = {
	encrypting: "Encrypting",
	uploading: "Uploading",
	processing: "Finishing",
	downloading: "Downloading",
	decrypting: "Decrypting",
};

/** The progress line of a step of the SDK. */
export function describeProgress(info: ProgressInfo): string {
	const percent = Math.floor(info.overallProgress * 100);
	const chunks =
		info.totalChunks === undefined ? "" : ` (${info.currentChunk ?? 0}/${info.totalChunks})`;
	return `${PHASES[info.phase]} ${percent}%${chunks}`;
}

/** What a password prompt needs of a terminal's input: a `tty.ReadStream`. */
export interface RawInput {
	setRawMode(mode: boolean): unknown;
	setEncoding(encoding: "utf8"): unknown;
	on(event: "data", listener: (chunk: string) => void): unknown;
	on(event: "end", listener: () => void): unknown;
	off(event: "data", listener: (chunk: string) => void): unknown;
	off(event: "end", listener: () => void): unknown;
	resume(): unknown;
	pause(): unknown;
}

const ENTER = new Set(["\r", "\n"]);
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const CTRL_U = "\u0015";
const ESCAPE = "\u001b";
const ERASE = new Set(["\u007f", "\b"]);

/**
 * A terminal over its input and output. A password is read in raw mode, so
 * nothing is echoed, which also turns Ctrl-C into a character: it interrupts
 * the command as the signal would.
 */
export function terminalOver(
	input: RawInput,
	output: { write(text: string): unknown },
	close: () => void,
): Terminal {
	input.setEncoding("utf8");
	const readHidden = (prompt: string, signal: AbortSignal): Promise<string> =>
		new Promise<string>((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			let answer = "";
			const settle = (error?: unknown): void => {
				input.off("data", onData);
				input.off("end", onEnd);
				signal.removeEventListener("abort", onAbort);
				input.setRawMode(false);
				input.pause();
				output.write("\n");
				if (error === undefined) {
					resolve(answer);
				} else {
					reject(error);
				}
			};
			const onData = (chunk: string): void => {
				for (const char of chunk) {
					if (ENTER.has(char)) {
						settle();
						return;
					}
					if (char === CTRL_C) {
						settle(new CliError("interrupted", EXIT.interrupted));
						return;
					}
					if (char === CTRL_D) {
						settle(answer === "" ? nothingTyped() : undefined);
						return;
					}
					if (char === ESCAPE) {
						// An escape sequence, an arrow key say, comes in one chunk: drop it whole.
						return;
					}
					if (ERASE.has(char)) {
						answer = Array.from(answer).slice(0, -1).join("");
					} else if (char === CTRL_U) {
						answer = "";
					} else if (char >= " ") {
						answer += char;
					}
				}
			};
			const onEnd = (): void => settle(nothingTyped());
			const onAbort = (): void => settle(signal.reason);

			output.write(prompt);
			input.setRawMode(true);
			input.on("data", onData);
			input.on("end", onEnd);
			signal.addEventListener("abort", onAbort, { once: true });
			input.resume();
		});
	return {
		readHidden,
		write: (text) => {
			output.write(text);
		},
		close,
	};
}

function nothingTyped(): CliError {
	return new CliError("nothing was typed", EXIT.usage);
}

/**
 * The controlling terminal, `/dev/tty`, opened apart from stdin and stdout,
 * which may carry the note; undefined when the process has none (a CI job, a
 * cron, Windows).
 */
export function openControllingTerminal(): Terminal | undefined {
	let inputFd: number;
	let outputFd: number;
	try {
		inputFd = openSync("/dev/tty", "r");
	} catch {
		return undefined;
	}
	try {
		outputFd = openSync("/dev/tty", "w");
	} catch {
		closeSync(inputFd);
		return undefined;
	}
	const input = new ReadStream(inputFd);
	const output = new WriteStream(outputFd);
	return terminalOver(input, output, () => {
		input.destroy();
		output.destroy();
	});
}
