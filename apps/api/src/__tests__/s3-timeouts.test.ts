import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { S3_TIMEOUTS, S3Storage, type S3Timeouts } from "../storage/s3.js";

/*
 * The real SDK client against endpoints that misbehave: what s3.test.ts cannot
 * show with a mocked client, that the SDK honors the timeouts S3Storage hands
 * it. The bounds are shortened to keep the tests quick. Below 6 s the SDK sets
 * its idle timeout as the request starts; the production value is only set
 * 3 s in, and dropped once the headers are in, which is why a body that
 * stalls after a quick answer needs a guard of its own.
 */

let server: Server | undefined;
let requests = 0;

/** An endpoint that counts requests and hands each to `respond`. */
async function endpoint(
	respond: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
	requests = 0;
	server = createServer((request, response) => {
		requests++;
		respond(request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/** An endpoint that answers none of its requests. */
function silentEndpoint(): Promise<string> {
	return endpoint(() => {});
}

/** Answers with headers and the start of a body, then nothing. */
function stall(response: ServerResponse): void {
	response.writeHead(200, { "Content-Type": "application/xml" });
	response.write('<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult>');
}

function storageAt(endpoint: string, timeouts: Partial<S3Timeouts>): S3Storage {
	return new S3Storage(
		{
			bucket: "test-bucket",
			region: "us-east-1",
			endpoint,
			accessKeyId: "test-key",
			secretAccessKey: "test-secret",
			forcePathStyle: true,
		},
		{ ...S3_TIMEOUTS, ...timeouts },
	);
}

afterEach(() => {
	server?.closeAllConnections();
	server?.close();
	server = undefined;
});

it("gives up on an endpoint that never answers, after two retries", async () => {
	const storage = storageAt(await silentEndpoint(), { idleMs: 200 });

	await expect(storage.read("notes/note123")).rejects.toMatchObject({ name: "TimeoutError" });
	expect(requests).toBe(3);

	await storage.close();
});

it("holds the health probe to its deadline, without retrying", async () => {
	const storage = storageAt(await silentEndpoint(), { probeMs: 300 });
	const started = Date.now();

	await expect(storage.probe()).rejects.toMatchObject({ name: "AbortError" });
	expect(Date.now() - started).toBeLessThan(2_000);
	expect(requests).toBe(1);

	await storage.close();
});

it("gives up on a listing that stops arriving after its headers, at the request deadline", async () => {
	// The production idle bound, which the SDK has dropped by then: only the
	// deadline ends the purge.
	const storage = storageAt(
		await endpoint((request, response) => {
			if (request.method === "DELETE") {
				response.writeHead(204).end();
				return;
			}
			stall(response);
		}),
		{ requestMs: 300 },
	);
	const started = Date.now();

	await expect(storage.purge("note123")).rejects.toMatchObject({ name: "AbortError" });
	expect(Date.now() - started).toBeLessThan(2_000);
	// The file object's delete, then the listing: no attempt past the deadline.
	expect(requests).toBe(2);

	await storage.close();
});

it("gives up on a batch delete that stalls the same way, and deletes its keys one by one", async () => {
	const deleted: string[] = [];
	const storage = storageAt(
		await endpoint((request, response) => {
			if (request.method === "DELETE") {
				deleted.push(request.url ?? "");
				response.writeHead(204).end();
				return;
			}
			if (request.method === "GET") {
				response
					.writeHead(200, { "Content-Type": "application/xml" })
					.end(
						'<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><IsTruncated>false</IsTruncated>' +
							"<Contents><Key>notes/note123/chunk_0</Key></Contents></ListBucketResult>",
					);
				return;
			}
			// The DeleteObjects call.
			stall(response);
		}),
		{ requestMs: 300 },
	);
	const started = Date.now();

	await expect(storage.purge("note123")).resolves.toBeUndefined();
	expect(Date.now() - started).toBeLessThan(2_000);
	expect(deleted).toEqual([
		"/test-bucket/notes/note123?x-id=DeleteObject",
		"/test-bucket/notes/note123/chunk_0?x-id=DeleteObject",
	]);

	await storage.close();
});

/** Takes each request's body, then answers nothing: no silence before the body ends. */
function swallowingEndpoint(): Promise<string> {
	return endpoint((request) => {
		request.resume();
	});
}

it.each([
	["a file note", (storage: S3Storage) => storage.save("note123", Buffer.alloc(1024))],
	["a chunk", (storage: S3Storage) => storage.saveChunk("note123", 0, Buffer.alloc(1024))],
])("holds the upload of %s to its deadline", async (_what, upload) => {
	// The production idle bound, which this test would wait out: only the
	// deadline ends the upload.
	const storage = storageAt(await swallowingEndpoint(), {
		uploadBaseMs: 300,
		uploadBytesPerSecond: 1024 * 1024,
	});
	const started = Date.now();

	await expect(upload(storage)).rejects.toMatchObject({ name: "AbortError" });
	expect(Date.now() - started).toBeLessThan(2_000);

	await storage.close();
});

it("gives a larger upload a longer deadline", async () => {
	const storage = storageAt(await swallowingEndpoint(), {
		uploadBaseMs: 100,
		uploadBytesPerSecond: 1024,
	});
	const started = Date.now();

	// 100 ms, then 1 KiB/s for 600 bytes: about 0.7 s.
	await expect(storage.saveChunk("note123", 0, Buffer.alloc(600))).rejects.toMatchObject({
		name: "AbortError",
	});
	const elapsed = Date.now() - started;
	expect(elapsed).toBeGreaterThanOrEqual(650);
	expect(elapsed).toBeLessThan(2_000);

	await storage.close();
});
