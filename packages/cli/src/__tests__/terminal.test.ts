import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CliError, EXIT } from "../errors.js";
import {
	createScreen,
	describeProgress,
	type RawInput,
	sanitize,
	terminalOver,
	writeJson,
	writeLine,
	writeText,
} from "../terminal.js";
import { Output } from "./harness.js";

describe("sanitize", () => {
	it("keeps text, line feeds, tabs and anything beyond C1", () => {
		expect(sanitize("héllo\tworld\n日本 🎉")).toBe("héllo\tworld\n日本 🎉");
	});

	it("shows the C0 controls as their pictures, ESC included", () => {
		expect(sanitize("\u001b[2Jcleared\u0000\u0007")).toBe("␛[2Jcleared␀␇");
	});

	it("shows DEL and the C1 controls, CSI included", () => {
		expect(sanitize("a\u007fb\u009b31mc\u0085")).toBe("a␡b�31mc�");
	});

	it("drops the carriage return of a Windows line ending, not a lone one", () => {
		expect(sanitize("one\r\ntwo\rthree")).toBe("one\ntwo␍three");
	});
});

describe("writeLine", () => {
	it("writes the line as it is when the stream is no terminal", () => {
		const stream = new Output(false);
		writeLine(stream, "a\u001bb");
		expect(stream.text).toBe("a\u001bb\n");
	});

	it("makes it safe on a terminal", () => {
		const stream = new Output(true);
		writeLine(stream, "a\u001bb");
		expect(stream.text).toBe("a␛b\n");
	});
});

describe("writeText", () => {
	it("writes the exact text when the stream is no terminal", () => {
		const stream = new Output(false);
		writeText(stream, "no line feed\u001b");
		expect(stream.text).toBe("no line feed\u001b");
	});

	it("makes it safe on a terminal, and ends it with a line feed", () => {
		const stream = new Output(true);
		writeText(stream, "text\u001b");
		expect(stream.text).toBe("text␛\n");
	});

	it("adds no line feed to a text that has one, or to nothing", () => {
		const ended = new Output(true);
		writeText(ended, "text\r\n");
		expect(ended.text).toBe("text\n");
		const empty = new Output(true);
		writeText(empty, "");
		expect(empty.text).toBe("");
	});
});

describe("writeJson", () => {
	const value = { text: "a\u001bb\u007fc\u009bd🎉" };

	it("writes one line of JSON", () => {
		const stream = new Output(false);
		writeJson(stream, value);
		expect(stream.text).toBe(`${JSON.stringify(value)}\n`);
		expect(JSON.parse(stream.text)).toEqual(value);
	});

	it("escapes DEL and C1 on a terminal, which keeps the value", () => {
		const stream = new Output(true);
		writeJson(stream, value);
		expect(stream.text).toBe('{"text":"a\\u001bb\\u007fc\\u009bd🎉"}\n');
		expect(JSON.parse(stream.text)).toEqual(value);
	});
});

describe("createScreen", () => {
	it("rewrites one progress line on a terminal, and erases it before information", () => {
		const stderr = new Output(true);
		const screen = createScreen(stderr, false);
		screen.progress("Uploading 10%");
		screen.progress("Uploading 10%");
		screen.progress("Uploading 50%");
		screen.info("Done");
		screen.done();
		expect(stderr.text).toBe("\r\u001b[KUploading 10%\r\u001b[KUploading 50%\r\u001b[KDone\n");
	});

	it("shows no progress on what is no terminal, but the information", () => {
		const stderr = new Output(false);
		const screen = createScreen(stderr, false);
		screen.progress("Uploading 10%");
		screen.info("Done");
		expect(stderr.text).toBe("Done\n");
	});

	it("shows nothing with --quiet", () => {
		const stderr = new Output(true);
		const screen = createScreen(stderr, true);
		screen.progress("Uploading 10%");
		screen.info("Done");
		screen.done();
		expect(stderr.text).toBe("");
	});
});

describe("describeProgress", () => {
	it("names the phase and the percent", () => {
		expect(describeProgress({ phase: "encrypting", phaseProgress: 0, overallProgress: 0 })).toBe(
			"Encrypting 0%",
		);
		expect(
			describeProgress({ phase: "downloading", phaseProgress: 0.5, overallProgress: 0.355 }),
		).toBe("Downloading 35%");
	});

	it("counts the chunks of an upload session", () => {
		expect(
			describeProgress({
				phase: "uploading",
				phaseProgress: 0.5,
				overallProgress: 0.55,
				currentChunk: 3,
				totalChunks: 6,
			}),
		).toBe("Uploading 55% (3/6)");
		expect(
			describeProgress({
				phase: "uploading",
				phaseProgress: 0,
				overallProgress: 0.2,
				totalChunks: 6,
			}),
		).toBe("Uploading 20% (0/6)");
	});
});

/** A terminal's input, as `tty.ReadStream` is to the prompt. */
class FakeInput extends EventEmitter implements RawInput {
	readonly rawModes: boolean[] = [];
	encoding: string | undefined;
	paused = true;

	setRawMode(mode: boolean): this {
		this.rawModes.push(mode);
		return this;
	}

	setEncoding(encoding: "utf8"): this {
		this.encoding = encoding;
		return this;
	}

	resume(): this {
		this.paused = false;
		return this;
	}

	pause(): this {
		this.paused = true;
		return this;
	}

	type(...chunks: string[]): void {
		for (const chunk of chunks) {
			this.emit("data", chunk);
		}
	}
}

function terminal() {
	const input = new FakeInput();
	const output = new Output(true);
	const close = vi.fn();
	return { input, output, close, terminal: terminalOver(input, output, close) };
}

describe("terminalOver", () => {
	it("reads a line in raw mode, echoing nothing, then gives the terminal back", async () => {
		const { input, output, terminal: tty } = terminal();
		expect(input.encoding).toBe("utf8");
		const answer = tty.readHidden("Password: ", new AbortController().signal);
		input.type("hun", "ter2\r");
		await expect(answer).resolves.toBe("hunter2");
		expect(output.text).toBe("Password: \n");
		expect(input.rawModes).toEqual([true, false]);
		expect(input.paused).toBe(true);
		expect(input.listenerCount("data")).toBe(0);
		expect(input.listenerCount("end")).toBe(0);
	});

	it("ends the line at a line feed, and ignores what follows it", async () => {
		const { input, terminal: tty } = terminal();
		const answer = tty.readHidden("> ", new AbortController().signal);
		input.type("pass\nmore");
		await expect(answer).resolves.toBe("pass");
	});

	it("erases a character, a whole one, and the whole line", async () => {
		const { input, terminal: tty } = terminal();
		const answer = tty.readHidden("> ", new AbortController().signal);
		input.type("ab🎉\u007f", "c\b", "d", "\u0015xyz", "\r");
		await expect(answer).resolves.toBe("xyz");
	});

	it("drops the escape sequence of a key, and the other controls", async () => {
		const { input, terminal: tty } = terminal();
		const answer = tty.readHidden("> ", new AbortController().signal);
		input.type("ab", "\u001b[A", "c\u0001d", "\r");
		await expect(answer).resolves.toBe("abcd");
	});

	it("turns Ctrl-C into an interruption", async () => {
		const { input, terminal: tty } = terminal();
		const answer = tty.readHidden("> ", new AbortController().signal);
		input.type("ab\u0003");
		const error = await answer.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(CliError);
		expect((error as CliError).exitCode).toBe(EXIT.interrupted);
		expect(input.rawModes).toEqual([true, false]);
	});

	it("takes Ctrl-D as the end of what is typed, refused when nothing is", async () => {
		const { input, terminal: tty } = terminal();
		const typed = tty.readHidden("> ", new AbortController().signal);
		input.type("ab\u0004");
		await expect(typed).resolves.toBe("ab");

		const empty = tty.readHidden("> ", new AbortController().signal);
		input.type("\u0004");
		await expect(empty).rejects.toMatchObject({ exitCode: EXIT.usage });
	});

	it("fails when the terminal's input ends", async () => {
		const { input, terminal: tty } = terminal();
		const answer = tty.readHidden("> ", new AbortController().signal);
		input.emit("end");
		await expect(answer).rejects.toThrow("nothing was typed");
	});

	it("stops at an abort, with its reason", async () => {
		const { input, terminal: tty } = terminal();
		const controller = new AbortController();
		const answer = tty.readHidden("> ", controller.signal);
		controller.abort(new Error("stop"));
		await expect(answer).rejects.toThrow("stop");
		expect(input.rawModes).toEqual([true, false]);
	});

	it("asks nothing once aborted", async () => {
		const { input, output, terminal: tty } = terminal();
		const controller = new AbortController();
		controller.abort(new Error("stopped"));
		await expect(tty.readHidden("> ", controller.signal)).rejects.toThrow("stopped");
		expect(output.text).toBe("");
		expect(input.rawModes).toEqual([]);
	});

	it("writes to the terminal and closes it", () => {
		const { output, close, terminal: tty } = terminal();
		tty.write("Wrong password\n");
		tty.close();
		expect(output.text).toBe("Wrong password\n");
		expect(close).toHaveBeenCalledOnce();
	});
});
