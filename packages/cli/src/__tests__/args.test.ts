import { describe, expect, it } from "vitest";
import { parseArgv } from "../args.js";
import { UsageError } from "../errors.js";

describe("parseArgv", () => {
	describe("top level", () => {
		it("requires a command", () => {
			expect(() => parseArgv([])).toThrow(/No command given/);
			expect(() => parseArgv(["frobnicate"])).toThrow(/Unknown command 'frobnicate'/);
		});

		it.each([["--help"], ["-h"], ["help"]])("%s shows the general help", (flag) => {
			expect(parseArgv([flag])).toEqual({ kind: "help" });
			expect(parseArgv([flag, "nope"])).toEqual({ kind: "help" });
		});

		it("help <command> and <command> --help show that command's help", () => {
			expect(parseArgv(["help", "get"])).toEqual({ kind: "help", command: "get" });
			expect(parseArgv(["send", "-h"])).toEqual({ kind: "help", command: "send" });
			expect(parseArgv(["get", "--help"])).toEqual({ kind: "help", command: "get" });
			expect(parseArgv(["check", "--help"])).toEqual({ kind: "help", command: "check" });
			expect(parseArgv(["delete", "--help"])).toEqual({ kind: "help", command: "delete" });
		});

		it.each([["--version"], ["-V"]])("%s reports the version", (flag) => {
			expect(parseArgv([flag])).toEqual({ kind: "version" });
		});

		it("turns the parser's own errors into usage errors", () => {
			expect(() => parseArgv(["send", "--bogus"])).toThrow(UsageError);
			expect(() => parseArgv(["send", "--bogus"])).toThrow(/Unknown option '--bogus'/);
			expect(() => parseArgv(["get", "--password"])).toThrow(/argument missing/);
		});
	});

	describe("send", () => {
		it("defaults to no options and no files", () => {
			expect(parseArgv(["send"])).toEqual({ kind: "send", args: { files: [], json: false } });
		});

		it("collects every option", () => {
			expect(
				parseArgv([
					"send",
					"a.txt",
					"-t",
					"hello",
					"--password=pw",
					"--expires",
					"2h",
					"--reads",
					"3",
					"--json",
					"-s",
					"https://s.example",
					"-k",
					"key",
					"b.png",
				]),
			).toEqual({
				kind: "send",
				args: {
					server: "https://s.example",
					apiKey: "key",
					files: ["a.txt", "b.png"],
					text: "hello",
					password: "pw",
					expiresIn: 7200,
					maxReads: 3,
					json: true,
				},
			});
		});

		it("maps --burn to a single read", () => {
			expect(parseArgv(["send", "--burn"])).toMatchObject({ args: { maxReads: 1 } });
		});

		it("refuses --burn together with --reads", () => {
			expect(() => parseArgv(["send", "-b", "-r", "5"])).toThrow(/mutually exclusive/);
		});

		it("validates --expires and --reads", () => {
			expect(() => parseArgv(["send", "-e", "soon"])).toThrow(/Invalid duration/);
			expect(() => parseArgv(["send", "-r", "1.5"])).toThrow(/Invalid read count/);
		});
	});

	describe("get", () => {
		it("takes exactly one URL", () => {
			expect(parseArgv(["get", "https://s.example/note/id#key"])).toEqual({
				kind: "get",
				args: { url: "https://s.example/note/id#key", force: false },
			});
			expect(() => parseArgv(["get"])).toThrow(/Missing argument for 'get': <url>/);
			expect(() => parseArgv(["get", "a", "b"])).toThrow(/Unexpected argument for 'get': 'b'/);
		});

		it("collects every option", () => {
			expect(
				parseArgv(["get", "url", "-p", "pw", "-o", "./dl", "-f", "--server", "https://s.example"]),
			).toEqual({
				kind: "get",
				args: {
					server: "https://s.example",
					url: "url",
					password: "pw",
					outDir: "./dl",
					force: true,
				},
			});
		});
	});

	describe("check", () => {
		it("takes one URL and an optional --json", () => {
			expect(parseArgv(["check", "id1"])).toEqual({
				kind: "check",
				args: { url: "id1", json: false },
			});
			expect(parseArgv(["check", "id1", "--json", "--api-key", "k"])).toEqual({
				kind: "check",
				args: { apiKey: "k", url: "id1", json: true },
			});
			expect(() => parseArgv(["check"])).toThrow(UsageError);
		});
	});

	describe("delete", () => {
		it("takes a URL and a delete token", () => {
			expect(parseArgv(["delete", "id1", "tok"])).toEqual({
				kind: "delete",
				args: { url: "id1", deleteToken: "tok" },
			});
			expect(() => parseArgv(["delete", "id1"])).toThrow(
				/Missing argument for 'delete': <deleteToken>/,
			);
			expect(() => parseArgv(["delete"])).toThrow(/<url> <deleteToken>/);
			expect(() => parseArgv(["delete", "a", "b", "c"])).toThrow(/Unexpected argument/);
		});
	});
});
