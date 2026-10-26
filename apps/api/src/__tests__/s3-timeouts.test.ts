import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { S3_TIMEOUTS, S3Storage, type S3Timeouts } from "../storage/s3.js";

/*
 * The real SDK client against an endpoint that takes every request and never
 * answers: what s3.test.ts cannot show with a mocked client, that the SDK
 * honors the timeouts S3Storage hands it. The bounds are shortened to keep the
 * test quick. Below 6 s the SDK sets its idle timeout as the request starts;
 * the production value is only set 3 s in, which is why a body that stalls
 * after a quick answer has a guard of its own (see s3.test.ts).
 */

let server: Server | undefined;
let requests = 0;

/** An endpoint that counts requests and answers none. */
async function silentEndpoint(): Promise<string> {
	requests = 0;
	server = createServer(() => {
		requests++;
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
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
