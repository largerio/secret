import type { FileHandle } from "node:fs/promises";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { NoteFileInfo } from "@largerio/secret-sdk";
import { CliError, EXIT, errnoOf, reasonOf } from "./errors.js";
import { FORMAT_CHARACTER } from "./terminal.js";

/** A file of a note, once written whole and verified. */
export interface WrittenFile {
	/** The name the sender gave it. */
	readonly name: string;
	/** Where it was written. */
	readonly path: string;
	readonly type: string;
	readonly size: number;
}

/** Where `secret read` writes a note's files. */
export interface OutputDirectory {
	/**
	 * Opens the stream the SDK writes a file to (`readNoteInto`'s `openFile`):
	 * a `.part` file until the stream is closed, renamed then under a safe name
	 * that overwrites nothing, removed if the stream is aborted.
	 */
	open(file: NoteFileInfo, index: number): Promise<WritableStream<Uint8Array>>;
	/** The files closed so far, in order. */
	readonly written: ReadonlyArray<WrittenFile>;
	/**
	 * Removes every `.part` file still open: the read was interrupted. A write
	 * under way is waited for; a rename under way too, which keeps its file, as
	 * do the files closed before. Whatever follows (an open, a write, a close)
	 * is refused. Idempotent; rejects if a `.part` file could not be removed.
	 */
	discard(): Promise<void>;
}

/**
 * The longest name ext4, APFS and most file systems take, in bytes of UTF-8.
 * A name that fits holds no more UTF-16 units, NTFS's limit.
 */
const MAX_NAME_BYTES = 255;
const PART = ".part";
/** How many suffixes a file tries before its name is given up on. */
const MAX_SUFFIX = 10_000;

/**
 * What a name may not hold: controls (C0, DEL, C1, among them the escape
 * that drives a terminal), lone surrogates, line and paragraph separators,
 * and the format characters a terminal may not show either.
 */
const UNSAFE = new RegExp(String.raw`[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]|${FORMAT_CHARACTER}`, "gu");
/**
 * What Windows refuses in a name. `:` would name a drive or an alternate data
 * stream there (`a.txt:x` writes into `a.txt`), and shows as `/` in Finder.
 */
const WINDOWS_UNSAFE = /[<>:"|?*]/g;
/**
 * A leading dot hides a file (`.bashrc`), a leading dash reads as an option
 * (`rm *`); a joiner joins nothing there, and would hide either.
 */
const LEADING = /^[\s.\-\u200C\u200D]+/u;
/** Windows drops trailing dots and spaces: `a.txt.` would be `a.txt` there. */
const TRAILING = /[\s.\u200C\u200D]+$/u;
/** Windows's device names, which no file may take, whatever its extension. */
const DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)\s*(?:\..*)?$/isu;
/** An extension, kept through a cut and a suffix: short, without dots or spaces. */
const EXTENSION = /\.[^\s.]{1,20}$/u;

/**
 * Where `secret read` writes a note's files: `dir`, which must exist.
 *
 * The sender picks the files' names, count, sizes and bytes, and may mean
 * harm, while `secret read` often runs in a home directory or a repository.
 * So a file is written:
 * - directly inside `dir`, under the last segment of the name it was sent
 *   under, made safe by the rules above, or `file-<n>` when nothing is left;
 * - never over anything there, a link included, nor over another file of the
 *   note: a name taken gets the first free suffix, `name (1).ext`, in the
 *   note's order, so the same note gets the same names however it is read;
 * - only once the SDK has checked the whole note: until then, it is a `.part`
 *   file of its owner's only (mode `0600`), removed if the read fails.
 */
export function createOutputDirectory(dir: string): OutputDirectory {
	return new Directory(dir);
}

/** A name split around its extension, the suffix going between the two. */
interface SplitName {
	readonly stem: string;
	readonly extension: string;
}

/**
 * Where a file is in its life: written to (`open`), being renamed
 * (`closing`), kept (`done`), or removed (`dropped`).
 */
type State = "open" | "closing" | "done" | "dropped";

interface Entry {
	readonly index: number;
	readonly file: NoteFileInfo;
	readonly split: SplitName;
	/** The suffix the file's name was given when opened, and that name. */
	readonly suffix: number;
	readonly name: string;
	/** The `.part` file's name. */
	readonly part: string;
	readonly handle: FileHandle;
	/** The empty file holding the file's name until the `.part` is renamed onto it. */
	placeholder: string | undefined;
	state: State;
	size: number;
	/** The stream's operation under way, settled. */
	busy: Promise<void>;
	/** The removal of what the file left, once begun. */
	removal: Promise<void> | undefined;
}

class Directory implements OutputDirectory {
	private readonly entries: Entry[] = [];
	private readonly done: Array<{ readonly index: number; readonly file: WrittenFile }> = [];
	/** Every name a file of this note holds or will hold, `.part` files included, by `keyOf`. */
	private readonly claimed = new Set<string>();
	/** The next suffix to try for a name, by `keyOf`: a name sent many times costs no more. */
	private readonly suffixes = new Map<string, number>();
	/** The files being opened, one after the other: names are given in the note's order. */
	private opening: Promise<unknown> = Promise.resolve();
	private discarded = false;

	constructor(private readonly dir: string) {}

	get written(): ReadonlyArray<WrittenFile> {
		return this.done.map(({ file }) => file);
	}

	async open(file: NoteFileInfo, index: number): Promise<WritableStream<Uint8Array>> {
		if (this.discarded) {
			throw interrupted();
		}
		const opened = this.opening.then(() => this.create(file, index));
		this.opening = opened.catch(ignore);
		const entry = await opened;
		if (this.discarded) {
			await this.discardEntry(entry);
			throw interrupted();
		}
		return new WritableStream<Uint8Array>({
			write: (chunk) => this.run(entry, () => this.write(entry, chunk)),
			close: () => this.run(entry, () => this.finish(entry)),
			abort: () => this.discardEntry(entry),
		});
	}

	async discard(): Promise<void> {
		this.discarded = true;
		await this.opening;
		await Promise.all(this.entries.map((entry) => this.discardEntry(entry)));
	}

	/** Gives a file its name and creates its `.part` file. */
	private async create(file: NoteFileInfo, index: number): Promise<Entry> {
		const name = safeName(file.name, index);
		const key = keyOf(name);
		const split = splitName(name);
		const first = this.suffixes.get(key) ?? 0;
		const taken = await this.firstFree(name, first, (suffix) => this.takePart(split, suffix));
		this.suffixes.set(key, taken.suffix + 1);
		const entry: Entry = {
			index,
			file,
			split,
			...taken,
			placeholder: undefined,
			state: "open",
			size: 0,
			busy: Promise.resolve(),
			removal: undefined,
		};
		this.entries.push(entry);
		return entry;
	}

	/** Takes `name (suffix).ext` and its `.part` file, if neither is taken. */
	private async takePart(split: SplitName, suffix: number) {
		const name = nameWith(split, suffix, MAX_NAME_BYTES);
		const part = `${nameWith(split, suffix, MAX_NAME_BYTES - PART.length)}${PART}`;
		if (!this.claim(name, part) || (await this.exists(name))) {
			return undefined;
		}
		const handle = await this.createExclusive(part);
		if (handle === undefined) {
			return undefined;
		}
		return { suffix, name, part, handle };
	}

	/** Takes the name a file was given, or, if something took it since, the next free one. */
	private async takeName(entry: Entry, suffix: number): Promise<string | undefined> {
		const name = nameWith(entry.split, suffix, MAX_NAME_BYTES);
		if (suffix !== entry.suffix && !this.claim(name)) {
			return undefined;
		}
		const handle = await this.createExclusive(name);
		if (handle === undefined) {
			return undefined;
		}
		entry.placeholder = name;
		await handle.close();
		return name;
	}

	/** The first suffix, from `first` on, that `take` takes. */
	private async firstFree<T>(
		name: string,
		first: number,
		take: (suffix: number) => Promise<T | undefined>,
	): Promise<T> {
		for (let suffix = first; suffix < MAX_SUFFIX; suffix++) {
			const taken = await take(suffix);
			if (taken !== undefined) {
				return taken;
			}
		}
		throw new CliError(`found no free name for ${name} in ${this.dir}`);
	}

	/** Claims names for a file of this note, unless one of them is claimed already. */
	private claim(...names: ReadonlyArray<string>): boolean {
		const keys = names.map(keyOf);
		if (keys.some((key) => this.claimed.has(key))) {
			return false;
		}
		for (const key of keys) {
			this.claimed.add(key);
		}
		return true;
	}

	/** Whether anything is at `name`, a dangling link included. */
	private async exists(name: string): Promise<boolean> {
		const path = join(this.dir, name);
		try {
			await lstat(path);
			return true;
		} catch (err) {
			if (errnoOf(err) === "ENOENT") {
				return false;
			}
			throw fileSystemFailure(`could not look up ${path}`, err);
		}
	}

	/**
	 * Creates the file `name`, or answers undefined if anything is there: `wx`
	 * (`O_CREAT | O_EXCL`) refuses an existing entry, a link included, which it
	 * does not follow, and lets the file system compare names its own way.
	 */
	private async createExclusive(name: string): Promise<FileHandle | undefined> {
		const path = join(this.dir, name);
		try {
			return await open(path, "wx", 0o600);
		} catch (err) {
			if (errnoOf(err) === "EEXIST") {
				return undefined;
			}
			throw fileSystemFailure(`could not create ${path}`, err);
		}
	}

	/** Runs a stream's operation, which `discardEntry` waits for. */
	private run(entry: Entry, operation: () => Promise<void>): Promise<void> {
		const running = operation();
		entry.busy = running.catch(ignore);
		return running;
	}

	private async write(entry: Entry, chunk: Uint8Array): Promise<void> {
		if (entry.state !== "open" || this.discarded) {
			throw interrupted();
		}
		try {
			// Writes the whole chunk at the file's position, however many writes it takes.
			await entry.handle.writeFile(chunk);
		} catch (err) {
			await this.drop(entry).catch(ignore);
			throw fileSystemFailure(`could not write ${join(this.dir, entry.part)}`, err);
		}
		entry.size += chunk.byteLength;
	}

	/** Keeps a file the SDK has checked: its `.part` file renamed onto a name of its own. */
	private async finish(entry: Entry): Promise<void> {
		if (entry.state !== "open" || this.discarded) {
			throw interrupted();
		}
		entry.state = "closing";
		const part = join(this.dir, entry.part);
		let path = join(this.dir, entry.name);
		try {
			// Some file systems (NFS) report a failed write only here.
			await entry.handle.close();
			const name = await this.firstFree(entry.name, entry.suffix, (suffix) =>
				this.takeName(entry, suffix),
			);
			path = join(this.dir, name);
			await rename(part, path);
		} catch (err) {
			await this.drop(entry).catch(ignore);
			throw fileSystemFailure(`could not save ${path}`, err);
		}
		entry.placeholder = undefined;
		entry.state = "done";
		const { name, type } = entry.file;
		this.done.push({ index: entry.index, file: { name, path, type, size: entry.size } });
		this.done.sort((a, b) => a.index - b.index);
	}

	/**
	 * Removes a file once its stream's operation under way is over, unless
	 * that operation kept it: a file being renamed is checked already.
	 */
	private async discardEntry(entry: Entry): Promise<void> {
		if (entry.state === "open") {
			entry.state = "dropped";
		}
		await entry.busy;
		if (entry.state !== "done") {
			await this.drop(entry);
		}
	}

	/** Removes what a file left, its `.part` file and its placeholder, once. */
	private drop(entry: Entry): Promise<void> {
		entry.state = "dropped";
		entry.removal ??= this.remove(entry);
		return entry.removal;
	}

	private async remove(entry: Entry): Promise<void> {
		await entry.handle.close().catch(ignore);
		const names = entry.placeholder === undefined ? [entry.part] : [entry.part, entry.placeholder];
		await Promise.all(names.map((name) => removeFile(join(this.dir, name))));
	}
}

/** The name a file is written under, before any suffix and cut. */
function safeName(sent: string, index: number): string {
	const last = sent.slice(Math.max(sent.lastIndexOf("/"), sent.lastIndexOf("\\")) + 1);
	const name = last
		.normalize("NFC")
		.replace(UNSAFE, "_")
		.replace(WINDOWS_UNSAFE, "_")
		.replace(LEADING, "")
		.replace(TRAILING, "");
	if (name === "") {
		return `file-${index + 1}`;
	}
	return DEVICE.test(name) ? `_${name}` : name;
}

function splitName(name: string): SplitName {
	const extension = EXTENSION.exec(name)?.[0] ?? "";
	return { stem: name.slice(0, name.length - extension.length), extension };
}

/** `stem (suffix).extension`, its stem cut for the whole to hold in `bytes`. */
function nameWith({ stem, extension }: SplitName, suffix: number, bytes: number): string {
	const tail = `${suffix === 0 ? "" : ` (${suffix})`}${extension}`;
	return `${fit(stem, bytes - Buffer.byteLength(tail))}${tail}`;
}

/** The longest start of `text` that holds in `bytes` of UTF-8, cut between two code points. */
function fit(text: string, bytes: number): string {
	if (Buffer.byteLength(text) <= bytes) {
		return text;
	}
	let used = 0;
	let end = 0;
	for (const char of text) {
		used += Buffer.byteLength(char);
		if (used > bytes) {
			break;
		}
		end += char.length;
	}
	// The cut may leave a dot or a space last, which Windows would drop.
	return text.slice(0, end).replace(TRAILING, "");
}

/**
 * A name as a case-insensitive file system might compare it, and more
 * loosely: two names that might be one are kept apart.
 */
function keyOf(name: string): string {
	return name.normalize("NFKC").toUpperCase().toLowerCase();
}

/** Removes a file, if it is still there. */
async function removeFile(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (err) {
		if (errnoOf(err) === "ENOENT") {
			return;
		}
		throw fileSystemFailure(`could not remove ${path}, which holds part of a note: delete it`, err);
	}
}

/** A failure of the file system, in words the user can act on. */
function fileSystemFailure(action: string, err: unknown): CliError {
	if (err instanceof CliError) {
		return err;
	}
	return new CliError(`${action}: ${reasonOf(err)}`, EXIT.failure, { cause: err });
}

/** Swallows a failure another path reports: `discard` tells of a `.part` file left behind. */
function ignore(): undefined {
	return undefined;
}

function interrupted(): CliError {
	return new CliError("the read was interrupted: its files were discarded");
}
