import { describe, expect, it } from "vitest";
import { applyFormat, type TextState } from "../markdownEdit.js";

/** Write a state with `[` `]` marking the selection (or a lone `|` for a caret). */
function at(marked: string): TextState {
	const caret = marked.indexOf("|");
	if (caret !== -1) {
		return { value: marked.slice(0, caret) + marked.slice(caret + 1), start: caret, end: caret };
	}
	const open = marked.indexOf("[");
	const close = marked.indexOf("]");
	return {
		value: marked.slice(0, open) + marked.slice(open + 1, close) + marked.slice(close + 1),
		start: open,
		end: close - 1,
	};
}

describe("applyFormat", () => {
	it("wraps the selection in bold markers and keeps it selected", () => {
		expect(applyFormat(at("say [hello] now"), "bold")).toEqual(at("say **[hello]** now"));
	});

	it("leaves the caret between italic markers when nothing is selected", () => {
		expect(applyFormat(at("a | b"), "italic")).toEqual(at("a _|_ b"));
	});

	it("uses inline code for one line and a fence for several", () => {
		expect(applyFormat(at("run [ls] here"), "code")).toEqual(at("run `[ls]` here"));
		expect(applyFormat(at("[a\nb]"), "code")).toEqual(at("```\n[a\nb]\n```"));
	});

	it("turns the caret's line into a heading without touching the rest of it", () => {
		expect(applyFormat(at("first\nsec|ond"), "heading")).toEqual(at("first\n## sec|ond"));
		expect(applyFormat(at("[title]"), "heading")).toEqual(at("## [title]"));
	});

	it("prefixes every selected line as a list item", () => {
		expect(applyFormat(at("x\n[one\ntwo]"), "list")).toEqual({
			value: "x\n- one\n- two",
			start: 4,
			end: 13,
		});
		expect(applyFormat(at("ite|m"), "list")).toEqual(at("- ite|m"));
	});

	// Links contain brackets themselves, so these states are spelled out.
	it("selects the link target after linking selected text", () => {
		expect(applyFormat({ value: "see docs", start: 4, end: 8 }, "link")).toEqual({
			value: "see [docs](https://)",
			start: 11,
			end: 19,
		});
	});

	it("puts the caret inside the brackets of an empty link", () => {
		expect(applyFormat({ value: "see ", start: 4, end: 4 }, "link")).toEqual({
			value: "see [](https://)",
			start: 5,
			end: 5,
		});
	});
});
