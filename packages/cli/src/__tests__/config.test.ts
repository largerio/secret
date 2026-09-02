import { SecretValidationError } from "@largerio/secret-sdk";
import { describe, expect, it } from "vitest";
import { parseNoteRef, requireApiKey, requireServer, resolveConnection } from "../config.js";
import { UsageError } from "../errors.js";

describe("resolveConnection", () => {
	it("returns nothing when nothing is configured", () => {
		expect(resolveConnection({}, {})).toEqual({});
	});

	it("prefers the flag over the environment over the note URL", () => {
		const env = { SECRET_SERVER_URL: "https://env.example", SECRET_API_KEY: "env-key" };
		expect(
			resolveConnection({ server: "https://flag.example" }, env, "https://note.example"),
		).toEqual({ serverUrl: "https://flag.example", apiKey: "env-key" });
		expect(resolveConnection({}, env, "https://note.example")).toEqual({
			serverUrl: "https://env.example",
			apiKey: "env-key",
		});
		expect(resolveConnection({}, {}, "https://note.example")).toEqual({
			serverUrl: "https://note.example",
		});
		expect(resolveConnection({ apiKey: "flag-key" }, env)).toEqual({
			serverUrl: "https://env.example",
			apiKey: "flag-key",
		});
	});

	it("ignores empty environment values", () => {
		expect(
			resolveConnection({}, { SECRET_SERVER_URL: "", SECRET_API_KEY: "" }, "https://n.io"),
		).toEqual({ serverUrl: "https://n.io" });
	});

	it("strips trailing slashes so the SDK does not double them", () => {
		expect(resolveConnection({ server: "https://s.example/sub//" }, {})).toEqual({
			serverUrl: "https://s.example/sub",
		});
		expect(resolveConnection({ server: "https://s.example/" }, {})).toEqual({
			serverUrl: "https://s.example",
		});
	});

	it("rejects a malformed or non-HTTP server URL and names its source", () => {
		expect(() => resolveConnection({ server: "not a url" }, {})).toThrow(UsageError);
		expect(() => resolveConnection({ server: "not a url" }, {})).toThrow(/from --server/);
		expect(() => resolveConnection({}, { SECRET_SERVER_URL: "ftp://s.example" })).toThrow(
			/from SECRET_SERVER_URL: 'ftp:\/\/s.example' \(expected http or https\)/,
		);
	});
});

describe("requireServer / requireApiKey", () => {
	it("returns the configured values", () => {
		expect(requireServer({ serverUrl: "https://s.example" })).toBe("https://s.example");
		expect(requireApiKey({ apiKey: "k" })).toBe("k");
	});

	it("explains how to configure a missing value", () => {
		expect(() => requireServer({})).toThrow(/--server <url> or set SECRET_SERVER_URL/);
		expect(() => requireApiKey({})).toThrow(/--api-key <key> or set SECRET_API_KEY/);
	});
});

describe("parseNoteRef", () => {
	it("splits an absolute share URL into id, key and instance", () => {
		expect(
			parseNoteRef("https://secret.example.com/note/aBcDeFgHiJkL#K7pQ", { needKey: true }),
		).toEqual({ id: "aBcDeFgHiJkL", keyFragment: "K7pQ", serverUrl: "https://secret.example.com" });
	});

	it("keeps a sub-path the instance is mounted under", () => {
		expect(
			parseNoteRef(" https://host.example/apps/secret/note/id1#key ", { needKey: false }),
		).toEqual({ id: "id1", keyFragment: "key", serverUrl: "https://host.example/apps/secret" });
	});

	it("accepts a relative share URL, with no instance to derive", () => {
		expect(parseNoteRef("/note/id1#key", { needKey: true })).toEqual({
			id: "id1",
			keyFragment: "key",
		});
	});

	it("accepts a URL without fragment, or a bare id, when no key is needed", () => {
		expect(parseNoteRef("https://s.example/note/id1", { needKey: false })).toEqual({
			id: "id1",
			serverUrl: "https://s.example",
		});
		expect(parseNoteRef("https://s.example/note/id%201/extra?x=1", { needKey: false })).toEqual({
			id: "id 1",
			serverUrl: "https://s.example",
		});
		expect(parseNoteRef("id1", { needKey: false })).toEqual({ id: "id1" });
	});

	it("refuses to decrypt without a key fragment", () => {
		expect(() => parseNoteRef("https://s.example/note/id1", { needKey: true })).toThrow(
			/carries no #key fragment/,
		);
	});

	it("rejects inputs that name no note", () => {
		expect(() => parseNoteRef("", { needKey: false })).toThrow(UsageError);
		expect(() => parseNoteRef("some/path", { needKey: false })).toThrow(/Invalid note URL or id/);
		expect(() => parseNoteRef("https://s.example/other/id1", { needKey: false })).toThrow(
			/expected …\/note\/<id>/,
		);
		expect(() => parseNoteRef("https://s.example/note/", { needKey: false })).toThrow(UsageError);
		expect(() => parseNoteRef("http://", { needKey: false })).toThrow(UsageError);
		expect(() => parseNoteRef("https://s.example/other#key", { needKey: true })).toThrow(
			UsageError,
		);
	});

	it("relays the SDK's validation error for a malformed share URL", () => {
		expect(() => parseNoteRef("/nope#key", { needKey: true })).toThrow(SecretValidationError);
	});
});
