import type { ContentMode } from "@largerio/secret-shared";

export interface ComposerState {
	/** Whether the author turned formatting (Markdown) on. */
	readonly formatted: boolean;
	/** The last password the generator inserted into the note, if any. */
	readonly generated: string | null;
	readonly hasFiles: boolean;
}

/**
 * How the reader's page will render a note's text.
 *
 * A note holding nothing but the password the generator inserted is sent as
 * a "secret", which the reader sees as a password to copy. That is decided
 * from what the app itself generated, never guessed from the text: a typed
 * password stays ordinary text, and a short note never turns into one. With
 * attachments, the password is part of a larger note and stays text.
 */
export function resolveContentMode(text: string, state: ComposerState): ContentMode {
	if (!state.hasFiles && state.generated && text.trim() === state.generated) return "secret";
	return state.formatted ? "markdown" : "text";
}
