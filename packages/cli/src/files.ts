import type { NoteFileInfo } from "@largerio/secret-sdk";

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
	/** Removes every `.part` file still open: the read was interrupted. */
	discard(): Promise<void>;
}

export function createOutputDirectory(_dir: string): OutputDirectory {
	throw new Error("not implemented");
}
