import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeIo, type NodeIoStreams } from "../io.js";

function sink(isTTY?: boolean) {
	const chunks: string[] = [];
	return {
		chunks,
		stream: {
			...(isTTY !== undefined ? { isTTY } : {}),
			write: (chunk: string) => {
				chunks.push(chunk);
				return true;
			},
		},
	};
}

function streams(
	overrides: Partial<NodeIoStreams> = {},
): NodeIoStreams & { out: string[]; err: string[] } {
	const out = sink();
	const err = sink();
	return {
		stdin: Readable.from([]),
		stdout: out.stream,
		stderr: err.stream,
		env: {},
		...overrides,
		out: out.chunks,
		err: err.chunks,
	};
}

describe("createNodeIo", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "secret-cli-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("exposes the environment and the TTY flags", () => {
		const io = createNodeIo(
			streams({
				env: { SECRET_API_KEY: "k" },
				stdin: Object.assign(Readable.from([]), { isTTY: true }),
				stdout: sink(true).stream,
			}),
		);
		expect(io.env["SECRET_API_KEY"]).toBe("k");
		expect(io.stdinIsTTY).toBe(true);
		expect(io.stdoutIsTTY).toBe(true);

		const piped = createNodeIo(streams());
		expect(piped.stdinIsTTY).toBe(false);
		expect(piped.stdoutIsTTY).toBe(false);
	});

	it("reads stdin to the end, whatever the chunk type", async () => {
		const io = createNodeIo(streams({ stdin: Readable.from(["hé ", Buffer.from("là")]) }));
		expect(new TextDecoder().decode(await io.readStdin())).toBe("hé là");
	});

	it("writes to stdout and stderr", () => {
		const s = streams();
		const io = createNodeIo(s);
		io.writeOut("out\n");
		io.writeErr("err\n");
		expect(s.out).toEqual(["out\n"]);
		expect(s.err).toEqual(["err\n"]);
	});

	it("reads and writes files, replacing an existing one", async () => {
		const io = createNodeIo(streams());
		const path = join(dir, "a.bin");
		await io.writeFile(path, new Uint8Array([1, 2, 3]));
		expect(await io.readFile(path)).toEqual(new Uint8Array([1, 2, 3]));

		await io.writeFile(path, new Uint8Array([4]));
		expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([4]));
	});

	it("reports whether a path exists", async () => {
		const io = createNodeIo(streams());
		const path = join(dir, "a.bin");
		expect(await io.fileExists(path)).toBe(false);
		await io.writeFile(path, new Uint8Array([1]));
		expect(await io.fileExists(path)).toBe(true);
		expect(await io.fileExists(dir)).toBe(true);
	});

	it("relays filesystem errors untouched", async () => {
		const io = createNodeIo(streams());
		await expect(
			io.writeFile(join(dir, "missing", "a.bin"), new Uint8Array([1])),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("creates directories recursively and tolerates existing ones", async () => {
		const io = createNodeIo(streams());
		const nested = join(dir, "a", "b");
		await io.ensureDir(nested);
		await io.ensureDir(nested);
		expect((await stat(nested)).isDirectory()).toBe(true);
	});
});
