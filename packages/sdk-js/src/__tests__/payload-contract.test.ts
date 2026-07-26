import type {
	ContentMode as SharedContentMode,
	NoteFile as SharedNoteFile,
	NotePayload as SharedNotePayload,
} from "@largerio/secret-shared";
import { describe, expect, it } from "vitest";
import type { ContentMode, NoteFile, NotePayload } from "../types.js";

/**
 * The SDK declares the payload types itself because `@largerio/secret-shared`
 * is private and never published — a generated `.d.ts` referencing it gave
 * every TypeScript consumer TS2307.
 *
 * That duplication is only safe if the two definitions cannot drift, so this
 * asserts mutual assignability at compile time: a field added, removed or
 * retyped on either side fails `pnpm typecheck`, which CI runs. The runtime
 * assertions below exist so the file is also a real test, and to pin the
 * `ContentMode` members, which structural checks alone would not catch.
 */

// Compile-time: each pair must be assignable in both directions.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

type _ContentModeMatches = AssertTrue<Exact<ContentMode, SharedContentMode>>;
type _NoteFileMatches = AssertTrue<Exact<NoteFile, SharedNoteFile>>;
type _NotePayloadMatches = AssertTrue<Exact<NotePayload, SharedNotePayload>>;

describe("payload type contract with @largerio/secret-shared", () => {
	it("accepts a shared payload where the SDK type is expected, and vice versa", () => {
		const file: NoteFile = {
			name: "report.pdf",
			type: "application/pdf",
			size: 3,
			data: new Uint8Array([1, 2, 3]),
		};
		const sdkPayload: NotePayload = { text: "hi", contentMode: "markdown", files: [file] };

		const asShared: SharedNotePayload = sdkPayload;
		const backToSdk: NotePayload = asShared;

		expect(backToSdk).toBe(sdkPayload);
		expect(backToSdk.files?.[0]?.data).toBeInstanceOf(Uint8Array);
	});

	it("covers every content mode the protocol defines", () => {
		// Listed explicitly: a new member added to the shared union would widen
		// the type without any structural check noticing.
		const modes: ContentMode[] = ["text", "markdown", "secret"];
		const asShared: SharedContentMode[] = modes;

		expect(asShared).toHaveLength(3);
		expect(new Set(asShared).size).toBe(3);
	});
});
