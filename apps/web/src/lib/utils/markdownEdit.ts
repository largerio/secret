/** A textarea's content and selection, before or after an edit. */
export interface TextState {
	readonly value: string;
	readonly start: number;
	readonly end: number;
}

export type MarkdownFormat = "heading" | "bold" | "italic" | "link" | "code" | "list";

const LINK_TARGET = "https://";

function lineStartOf(value: string, index: number): number {
	return value.lastIndexOf("\n", index - 1) + 1;
}

/** Put markers around the selection, keeping it selected; with none, leave the caret between them. */
function wrap({ value, start, end }: TextState, before: string, after: string): TextState {
	const selected = value.slice(start, end);
	const inner = start + before.length;
	return {
		value: `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`,
		start: inner,
		end: inner + selected.length,
	};
}

/** Prefix every line the selection touches. */
function prefixLines({ value, start, end }: TextState, prefix: string): TextState {
	const from = lineStartOf(value, start);
	const block = value.slice(from, end);
	const lines = block.split("\n");
	const prefixed = lines.map((line) => `${prefix}${line}`).join("\n");
	return {
		value: `${value.slice(0, from)}${prefixed}${value.slice(end)}`,
		start: start + prefix.length,
		end: end + prefix.length * lines.length,
	};
}

/** Turn the line holding the caret into a heading, keeping the selection where it was. */
function heading({ value, start, end }: TextState): TextState {
	const from = lineStartOf(value, start);
	const prefix = "## ";
	return {
		value: `${value.slice(0, from)}${prefix}${value.slice(from)}`,
		start: start + prefix.length,
		end: end + prefix.length,
	};
}

function link({ value, start, end }: TextState): TextState {
	const selected = value.slice(start, end);
	const inserted = `[${selected}](${LINK_TARGET})`;
	const next = `${value.slice(0, start)}${inserted}${value.slice(end)}`;
	if (!selected) return { value: next, start: start + 1, end: start + 1 };

	// The text is there already: select the target, ready to be replaced.
	const target = start + selected.length + 3;
	return { value: next, start: target, end: target + LINK_TARGET.length };
}

/** Apply one toolbar action to a textarea's state. */
export function applyFormat(state: TextState, format: MarkdownFormat): TextState {
	switch (format) {
		case "heading":
			return heading(state);
		case "bold":
			return wrap(state, "**", "**");
		case "italic":
			return wrap(state, "_", "_");
		case "code":
			return state.value.slice(state.start, state.end).includes("\n")
				? wrap(state, "```\n", "\n```")
				: wrap(state, "`", "`");
		case "link":
			return link(state);
		case "list":
			return prefixLines(state, "- ");
	}
}
