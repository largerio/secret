import { constants, openAsBlob, type Stats } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type ContentMode,
	DEFAULT_EXPIRY_SECONDS,
	MAX_EXPIRY_SECONDS,
	MAX_READS,
	MIN_EXPIRY_SECONDS,
} from "@largerio/secret-sdk";
import { passwordOfNewNote, readApiKey } from "../credentials.js";
import { CliError, EXIT, errnoOf, reasonOf } from "../errors.js";
import { translateError } from "../failures.js";
import {
	connect,
	fetchLimits,
	type Instance,
	instanceOf,
	type Limits,
	proofOfWork,
} from "../instance.js";
import { mimeTypeOf } from "../mime.js";
import { COMMON_OPTIONS, choiceOption, countOption, durationOption, parsing } from "../options.js";
import { readText } from "../stdin.js";
import { createScreen, describeProgress, writeJson, writeLine } from "../terminal.js";
import type { Io } from "../types.js";
import { formatDuration, formatSize } from "../units.js";

const OPTIONS = {
	...COMMON_OPTIONS,
	"max-reads": { type: "string" },
	expires: { type: "string" },
	mode: { type: "string" },
	format: { type: "string" },
	password: { type: "boolean" },
	"password-file": { type: "string" },
} as const;

interface SendOptions {
	readonly instance: Instance;
	readonly paths: ReadonlyArray<string>;
	readonly maxReads: number;
	readonly expiresIn: number | undefined;
	readonly contentMode: ContentMode | undefined;
	readonly format: 0 | 1 | undefined;
	readonly password: boolean;
	readonly passwordFile: string | undefined;
	readonly json: boolean;
	readonly quiet: boolean;
}

function optionsOf(args: ReadonlyArray<string>, io: Io): SendOptions {
	const { values, positionals } = parsing("send", () =>
		parseArgs({ args: [...args], options: OPTIONS, allowPositionals: true }),
	);
	const instance = values.instance ?? io.env["SECRET_INSTANCE"]?.trim();
	if (!instance) {
		throw new CliError(
			"no instance to send the note to: pass --instance <url>, or set SECRET_INSTANCE",
			EXIT.usage,
		);
	}
	const format = choiceOption(values.format, "--format", ["0", "1"]);
	return {
		instance: instanceOf(instance),
		paths: positionals,
		maxReads: countOption(values["max-reads"], "--max-reads", 1, MAX_READS),
		expiresIn: durationOption(values.expires, "--expires", MIN_EXPIRY_SECONDS, MAX_EXPIRY_SECONDS),
		contentMode: choiceOption(values.mode, "--mode", ["text", "markdown", "secret"]),
		format: format === undefined ? undefined : (Number(format) as 0 | 1),
		// A password file says the note has one.
		password: values.password === true || values["password-file"] !== undefined,
		passwordFile: values["password-file"],
		json: values.json === true,
		quiet: values.quiet === true,
	};
}

interface FileToSend {
	readonly name: string;
	readonly type: string;
	readonly data: Blob;
}

/**
 * The files named, each a Blob the SDK reads a slice at a time. A path that
 * names nothing is not repeated: it may be a secret typed where the text does
 * not go.
 */
async function openFiles(paths: ReadonlyArray<string>, cwd: string): Promise<FileToSend[]> {
	const files: FileToSend[] = [];
	for (const [index, path] of paths.entries()) {
		const full = resolve(cwd, path);
		let info: Stats;
		try {
			info = await stat(full);
		} catch (err) {
			const code = errnoOf(err);
			if (code === "ENOENT" || code === "ENOTDIR") {
				throw new CliError(
					`argument ${index + 1} names no file: the text of a note goes on stdin, as in secret send < note.txt`,
					EXIT.usage,
				);
			}
			throw new CliError(`cannot read ${path}: ${reasonOf(err)}`, EXIT.usage);
		}
		if (info.isDirectory()) {
			throw new CliError(`${path} is a directory: send an archive of it`, EXIT.usage);
		}
		if (!info.isFile()) {
			throw new CliError(`${path} is not a regular file`, EXIT.usage);
		}
		try {
			await access(full, constants.R_OK);
		} catch (err) {
			throw new CliError(`cannot read ${path}: ${reasonOf(err)}`, EXIT.usage);
		}
		files.push({ name: basename(full), type: mimeTypeOf(full), data: await openAsBlob(full) });
	}
	return files;
}

/** Refuses here what the instance would refuse once the note is encrypted. */
function checkLimits(
	files: ReadonlyArray<FileToSend>,
	expiresIn: number,
	limits: Limits,
	instance: Instance,
): void {
	if (files.length > limits.maxFilesPerNote) {
		throw new CliError(
			`${instance.origin} takes at most ${limits.maxFilesPerNote} files in a note`,
			EXIT.usage,
		);
	}
	if (expiresIn > limits.maxExpiry) {
		throw new CliError(
			`${instance.origin} keeps a note at most ${formatDuration(limits.maxExpiry)}: ask for less with --expires`,
			EXIT.usage,
		);
	}
	const size = files.reduce((total, file) => total + file.data.size, 0);
	if (size > limits.maxChunkedFileSize) {
		throw new CliError(
			`the files take ${formatSize(size)}, and ${instance.origin} takes at most ${formatSize(limits.maxChunkedFileSize)} in a note`,
			EXIT.usage,
		);
	}
}

/**
 * The note's text: stdin when it is piped in, else typed on the terminal
 * when there is no file to send. Nothing typed or piped is no text.
 */
async function textOf(io: Io, hasFiles: boolean): Promise<string | undefined> {
	if (io.stdin.isTTY) {
		if (hasFiles) {
			return undefined;
		}
		writeLine(io.stderr, "Type the secret, then press Ctrl-D:");
	}
	const text = await readText(io.stdin, io.signal);
	return text === "" ? undefined : text;
}

function describeReadLimit(maxReads: number): string {
	if (maxReads === 0) {
		return "it can be read any number of times until then";
	}
	return maxReads === 1 ? "it is deleted once read" : `it is deleted after ${maxReads} reads`;
}

export async function send(args: ReadonlyArray<string>, io: Io): Promise<void> {
	const options = optionsOf(args, io);
	const { instance } = options;
	const screen = createScreen(io.stderr, options.quiet);
	const apiKey = await readApiKey(io);
	try {
		const files = await openFiles(options.paths, io.cwd);
		const limits = await fetchLimits(io, instance);
		const expiresIn = options.expiresIn ?? Math.min(DEFAULT_EXPIRY_SECONDS, limits.maxExpiry);
		checkLimits(files, expiresIn, limits, instance);
		const text = await textOf(io, files.length > 0);
		if (text === undefined && files.length === 0) {
			throw new CliError("nothing to send: pipe the text on stdin, or name the files", EXIT.usage);
		}
		const password = options.password
			? await passwordOfNewNote(io, options.passwordFile)
			: undefined;

		const client = await connect(io, instance, apiKey);
		const capToken = apiKey === undefined ? await proofOfWork(io, instance, screen) : undefined;
		const note = await client.createNote({
			...(text === undefined ? {} : { text }),
			...(options.contentMode === undefined ? {} : { contentMode: options.contentMode }),
			...(files.length === 0 ? {} : { files }),
			...(password === undefined ? {} : { password }),
			...(capToken === undefined ? {} : { capToken }),
			...(options.format === undefined ? {} : { format: options.format }),
			maxReads: options.maxReads,
			expiresIn,
			chunkSize: limits.chunkSize,
			signal: io.signal,
			onProgress: (info) => screen.progress(describeProgress(info)),
		});
		screen.done();

		const link = client.buildShareUrl(note.id, note.keyFragment);
		if (options.json) {
			writeJson(io.stdout, {
				link,
				id: note.id,
				expiresAt: note.expiresAt,
				deleteToken: note.deleteToken,
				maxReads: options.maxReads,
			});
			return;
		}
		io.stdout.write(`${link}\n`);
		screen.info(
			`Expires ${note.expiresAt}, in ${formatDuration(expiresIn)}; ${describeReadLimit(options.maxReads)}.`,
		);
		screen.info(`Delete token: ${note.deleteToken}`);
		screen.info(`To delete it sooner: secret delete <link> --token ${note.deleteToken}`);
	} catch (err) {
		throw translateError(err, {
			instance,
			write: { apiKey: apiKey !== undefined, format: options.format ?? 1 },
			namesNote: false,
		});
	} finally {
		screen.done();
	}
}
