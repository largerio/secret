import { describe, expect, test, vi } from "vitest";
import { SecretApiError, SecretNetworkError } from "../errors.js";

async function catchApiError(promise: Promise<unknown>): Promise<SecretApiError> {
	try {
		await promise;
		throw new Error("Expected promise to reject");
	} catch (err) {
		if (err instanceof SecretApiError) return err;
		throw err;
	}
}

import type { HttpClientConfig } from "../http.js";
import {
	checkNote,
	completeChunkedUpload,
	deleteNote,
	getJson,
	getNote,
	getNoteRaw,
	getNoteStream,
	initChunkedUpload,
	postFormData,
	postJson,
	uploadChunk,
} from "../http.js";

function createConfig(fetchMock: typeof fetch, apiKey?: string): HttpClientConfig {
	return {
		baseUrl: "https://api.example.com",
		fetch: fetchMock,
		...(apiKey ? { apiKey } : {}),
	};
}

function okResponse(body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function errorResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("postJson", () => {
	test("sends POST with JSON body and returns parsed response", async () => {
		const responseBody = { id: "abc123", expiresAt: "2099-01-01", deleteToken: "tok" };
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(responseBody)));
		const config = createConfig(fetchMock);

		const result = await postJson(config, "/notes", { data: "test" });

		expect(result).toEqual(responseBody);
		expect(fetchMock).toHaveBeenCalledOnce();

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes");
		expect((init as RequestInit).method).toBe("POST");
		expect((init as RequestInit).headers).toEqual(
			expect.objectContaining({ "Content-Type": "application/json" }),
		);
		expect((init as RequestInit).body).toBe(JSON.stringify({ data: "test" }));
	});

	test("includes Authorization header when apiKey is set", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(okResponse({ id: "x", expiresAt: "", deleteToken: "" })),
		);
		const config = createConfig(fetchMock, "my-api-key");

		await postJson(config, "/notes", {});

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer my-api-key");
	});

	test("includes X-Cap-Token header when capToken is provided", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(okResponse({ id: "x", expiresAt: "", deleteToken: "" })),
		);
		const config = createConfig(fetchMock);

		await postJson(config, "/notes", {}, "my-cap-token");

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["X-Cap-Token"]).toBe("my-cap-token");
	});

	test("throws SecretApiError with error message from response body", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(422, { error: "Validation failed" })),
		);
		const config = createConfig(fetchMock);

		await expect(postJson(config, "/notes", {})).rejects.toThrow(SecretApiError);
		await expect(postJson(config, "/notes", {})).rejects.toThrow("Validation failed");
	});

	test("throws SecretApiError with HTTP status fallback when no error field", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(500, { message: "unexpected" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(postJson(config, "/notes", {}));
		expect(err.message).toBe("HTTP 500");
		expect(err.status).toBe(500);
	});

	test("throws SecretApiError with HTTP status fallback when error field is not a string", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(422, { error: 12345 })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(postJson(config, "/notes", {}));
		expect(err.message).toBe("HTTP 422");
		expect(err.status).toBe(422);
	});

	test("throws SecretApiError with fallback when response is not JSON", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response("not json", { status: 502 })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(postJson(config, "/notes", {}));
		expect(err.message).toMatch(/^HTTP \d+$/);
		expect(err.status).toBe(502);
	});
});

describe("postFormData", () => {
	test("sends FormData via fetch when no onProgress or no XMLHttpRequest", async () => {
		const responseBody = { id: "form1", expiresAt: "2099-01-01", deleteToken: "tok" };
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(responseBody)));
		const config = createConfig(fetchMock);

		const formData = new FormData();
		formData.append("metadata", "{}");

		const result = await postFormData(config, "/notes/upload", formData);

		expect(result).toEqual(responseBody);
		expect(fetchMock).toHaveBeenCalledOnce();

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes/upload");
		expect((init as RequestInit).method).toBe("POST");
	});

	test("falls back to fetch even with onProgress when XMLHttpRequest is undefined", async () => {
		const responseBody = { id: "form2", expiresAt: "2099-01-01", deleteToken: "tok" };
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(responseBody)));
		const config = createConfig(fetchMock);

		const formData = new FormData();
		const onProgress = vi.fn();

		const result = await postFormData(config, "/notes/upload", formData, onProgress);

		expect(result).toEqual(responseBody);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(onProgress).not.toHaveBeenCalled();
	});

	test("includes Authorization header when apiKey is set", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(okResponse({ id: "x", expiresAt: "", deleteToken: "" })),
		);
		const config = createConfig(fetchMock, "form-key");

		const formData = new FormData();
		await postFormData(config, "/notes/upload", formData);

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer form-key");
	});

	test("throws SecretApiError on non-ok response", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(413, { error: "File too large" })),
		);
		const config = createConfig(fetchMock);

		const formData = new FormData();
		await expect(postFormData(config, "/notes/upload", formData)).rejects.toThrow("File too large");
	});

	test("delegates to XHR module when onProgress provided and XHR available", async () => {
		const xhrModule = await import("../xhr.js");
		const isAvailableSpy = vi.spyOn(xhrModule, "isXhrAvailable").mockReturnValue(true);
		const xhrSpy = vi
			.spyOn(xhrModule, "postFormDataXhr")
			.mockResolvedValue({ id: "xhr1", expiresAt: "2099-01-01", deleteToken: "tok" });

		const fetchMock = vi.fn<typeof fetch>();
		const config = createConfig(fetchMock);
		const formData = new FormData();
		const onProgress = vi.fn();

		const result = await postFormData(config, "/notes/upload", formData, onProgress);

		expect(result.id).toBe("xhr1");
		expect(xhrSpy).toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();

		isAvailableSpy.mockRestore();
		xhrSpy.mockRestore();
	});
});

describe("getJson", () => {
	test("returns parsed JSON on success", async () => {
		const body = { data: "value" };
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(body)));
		const config = createConfig(fetchMock);

		const result = await getJson<{ data: string }>(config, "/data");

		expect(result).toEqual(body);
	});

	test("includes Authorization header when apiKey is set", async () => {
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse({ ok: true })));
		const config = createConfig(fetchMock, "get-key");

		await getJson(config, "/data");

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer get-key");
	});

	test("throws SecretApiError on non-ok response with error message", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(404, { error: "Not found" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getJson(config, "/missing"));
		expect(err.message).toBe("Not found");
		expect(err.status).toBe(404);
	});

	test("throws SecretApiError with HTTP status fallback when no error field", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(403, { detail: "forbidden" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getJson(config, "/forbidden"));
		expect(err.message).toBe("HTTP 403");
	});

	test("throws SecretApiError with fallback when error response is not JSON", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response("bad gateway", { status: 502 })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getJson(config, "/bad"));
		expect(err.message).toMatch(/^HTTP \d+$/);
		expect(err.status).toBe(502);
	});

	test("streams response with progress when onProgress and content-length are present", async () => {
		const body = { streamed: true };
		const bodyStr = JSON.stringify(body);
		const bodyBytes = new TextEncoder().encode(bodyStr);

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bodyBytes);
				controller.close();
			},
		});

		const response = new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(bodyBytes.length),
			},
		});

		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
		const config = createConfig(fetchMock);
		const onProgress = vi.fn();

		const result = await getJson<{ streamed: boolean }>(config, "/stream", onProgress);

		expect(result).toEqual(body);
		expect(onProgress).toHaveBeenCalledWith(1);
	});

	test("streams response with multiple chunks and reports progress", async () => {
		const body = { multi: "chunk" };
		const bodyStr = JSON.stringify(body);
		const bodyBytes = new TextEncoder().encode(bodyStr);
		const mid = Math.floor(bodyBytes.length / 2);
		const chunk1 = bodyBytes.slice(0, mid);
		const chunk2 = bodyBytes.slice(mid);

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk1);
				controller.enqueue(chunk2);
				controller.close();
			},
		});

		const response = new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(bodyBytes.length),
			},
		});

		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
		const config = createConfig(fetchMock);
		const onProgress = vi.fn();

		const result = await getJson<{ multi: string }>(config, "/stream", onProgress);

		expect(result).toEqual(body);
		expect(onProgress).toHaveBeenCalledTimes(2);
	});

	test("falls back to res.json() when onProgress is given but content-length is 0", async () => {
		const body = { fallback: true };
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(body)));
		const config = createConfig(fetchMock);
		const onProgress = vi.fn();

		const result = await getJson<{ fallback: boolean }>(config, "/no-length", onProgress);

		expect(result).toEqual(body);
		expect(onProgress).not.toHaveBeenCalled();
	});

	test("falls back to res.json() when onProgress is given but no content-length header", async () => {
		const body = { noHeader: true };
		const response = new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
		const config = createConfig(fetchMock);
		const onProgress = vi.fn();

		const result = await getJson<{ noHeader: boolean }>(config, "/no-cl", onProgress);

		expect(result).toEqual(body);
		expect(onProgress).not.toHaveBeenCalled();
	});
});

describe("getNote", () => {
	test("fetches note by id", async () => {
		const noteData = {
			encryptedData: "enc",
			clientNonce: "nonce",
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
		};
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(noteData)));
		const config = createConfig(fetchMock);

		const result = await getNote(config, "testId123456");

		expect(result).toEqual(noteData);
		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes/testId123456");
	});

	test("passes onProgress to getJson", async () => {
		const noteData = {
			encryptedData: "enc",
			clientNonce: "nonce",
			hasPassword: false,
			fileCount: 0,
			createdAt: "2024-01-01",
			expiresAt: "2099-01-01",
		};
		const bodyStr = JSON.stringify(noteData);
		const bodyBytes = new TextEncoder().encode(bodyStr);

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bodyBytes);
				controller.close();
			},
		});

		const response = new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(bodyBytes.length),
			},
		});

		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
		const config = createConfig(fetchMock);
		const onProgress = vi.fn();

		await getNote(config, "testId123456", onProgress);

		expect(onProgress).toHaveBeenCalled();
	});
});

describe("checkNote", () => {
	test("returns note info on 200", async () => {
		const info = {
			exists: true,
			hasPassword: false,
			fileCount: 0,
			expiresAt: "2099-01-01",
			maxReads: 1,
			chunked: false,
		};
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(info)));
		const config = createConfig(fetchMock);

		const result = await checkNote(config, "noteId123456");

		expect(result).toEqual(info);
		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes/noteId123456/exists");
	});

	test("returns {exists:false} for a missing note, which the API sends as a 200", async () => {
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse({ exists: false })));
		const config = createConfig(fetchMock);

		expect(await checkNote(config, "missing12345")).toEqual({ exists: false });
	});

	test("rejects a body that does not match the documented shape", async () => {
		// The old code cast the body straight to NoteInfo, so a truncated or
		// unexpected response reached the caller with required fields undefined
		// while the type claimed otherwise.
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(okResponse({ exists: true, hasPassword: false })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(checkNote(config, "noteId123456"));
		expect(err.message).toBe("Malformed response from /exists");
	});

	test.each([[null], ["a string"], [42], [{ exists: "maybe" }]])(
		"rejects a non-object or mistyped body: %s",
		async (body) => {
			const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(body)));
			const config = createConfig(fetchMock);

			const err = await catchApiError(checkNote(config, "noteId123456"));
			expect(err.message).toBe("Malformed response from /exists");
		},
	);

	test("surfaces a 404 as an error instead of a silent empty result", async () => {
		// The API answers 200 {exists:false}; a 404 here means something else is
		// wrong (a proxy, a wrong base URL) and must not look like "no such note".
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(404, { error: "Not found" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(checkNote(config, "missing12345"));
		expect(err.status).toBe(404);
	});

	test("throws on server error (non-404)", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(500, { error: "Internal error" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(checkNote(config, "noteId123456"));
		expect(err.status).toBe(500);
		expect(err.message).toBe("Internal error");
	});

	test("throws with HTTP fallback when error response is not JSON", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response("not json", { status: 502 })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(checkNote(config, "noteId123456"));
		expect(err.status).toBe(502);
		expect(err.message).toBe("HTTP 502");
	});

	test("includes Authorization header when apiKey is set", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(
				okResponse({
					exists: true,
					hasPassword: false,
					fileCount: 0,
					expiresAt: "",
					maxReads: 1,
					chunked: false,
				}),
			),
		);
		const config = createConfig(fetchMock, "check-key");

		await checkNote(config, "noteId123456");

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer check-key");
	});
});

describe("getNoteRaw", () => {
	function rawResponse(body: Uint8Array, headers: Record<string, string>): Response {
		return new Response(body as BodyInit, {
			status: 200,
			headers,
		});
	}

	const nonce = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	const nonceBase64 = btoa(String.fromCharCode(...nonce));

	const defaultHeaders: Record<string, string> = {
		"X-Client-Nonce": nonceBase64,
		"X-Has-Password": "false",
		"X-File-Count": "2",
		"X-Created-At": "2024-01-01T00:00:00Z",
		"X-Expires-At": "2099-01-01T00:00:00Z",
	};

	test("returns encryptedBytes, nonceBytes, and parsed headers on success", async () => {
		const bodyBytes = new Uint8Array([10, 20, 30, 40]);
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(rawResponse(bodyBytes, defaultHeaders)),
		);
		const config = createConfig(fetchMock);

		const result = await getNoteRaw(config, "noteId123456");

		expect(result.encryptedBytes).toEqual(bodyBytes);
		expect(result.nonceBytes).toEqual(nonce);
		expect(result.hasPassword).toBe(false);
		expect(result.fileCount).toBe(2);
		expect(result.createdAt).toBe("2024-01-01T00:00:00Z");
		expect(result.expiresAt).toBe("2099-01-01T00:00:00Z");
		expect(result.salt).toBeUndefined();

		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes/noteId123456/raw");
	});

	test("includes salt header when present", async () => {
		const bodyBytes = new Uint8Array([1]);
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(rawResponse(bodyBytes, { ...defaultHeaders, "X-Salt": "mySalt123" })),
		);
		const config = createConfig(fetchMock);

		const result = await getNoteRaw(config, "noteId123456");

		expect(result.salt).toBe("mySalt123");
	});

	test("defaults to 0 when X-File-Count header is negative", async () => {
		const bodyBytes = new Uint8Array([10]);
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(rawResponse(bodyBytes, { ...defaultHeaders, "X-File-Count": "-5" })),
		);
		const config = createConfig(fetchMock);

		const result = await getNoteRaw(config, "noteId123456");
		expect(result.fileCount).toBe(0);
	});

	test("throws SecretApiError on invalid base64 nonce", async () => {
		const bodyBytes = new Uint8Array([10]);
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(
				rawResponse(bodyBytes, { ...defaultHeaders, "X-Client-Nonce": "!!!invalid!!!" }),
			),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteRaw(config, "noteId123456"));
		expect(err.message).toBe("Invalid base64 encoding in response");
		expect(err.status).toBe(502);
	});

	test("throws SecretApiError on error response", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(404, { error: "Note not found" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteRaw(config, "missing12345"));
		expect(err.message).toBe("Note not found");
		expect(err.status).toBe(404);
	});

	test("throws SecretApiError with HTTP status fallback when no error field", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(403, { detail: "forbidden" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteRaw(config, "noteId123456"));
		expect(err.message).toBe("HTTP 403");
		expect(err.status).toBe(403);
	});

	test("throws SecretApiError with fallback when error response is not JSON", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response("bad", { status: 500 })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteRaw(config, "noteId123456"));
		expect(err.message).toMatch(/^HTTP \d+$/);
		expect(err.status).toBe(500);
	});

	test("throws when required response headers are missing", async () => {
		const bodyBytes = new Uint8Array([42]);
		const response = new Response(bodyBytes, {
			status: 200,
			headers: {},
		});
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteRaw(config, "noteId123456"));
		expect(err.message).toContain("Missing required header");
	});

	test("streams response with progress callback when Content-Length is present", async () => {
		const bodyBytes = new Uint8Array([10, 20, 30, 40, 50]);
		const mid = 2;
		const chunk1 = bodyBytes.slice(0, mid);
		const chunk2 = bodyBytes.slice(mid);

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk1);
				controller.enqueue(chunk2);
				controller.close();
			},
		});

		const response = new Response(stream, {
			status: 200,
			headers: {
				...defaultHeaders,
				"Content-Length": String(bodyBytes.length),
			},
		});

		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
		const config = createConfig(fetchMock);
		const onProgress = vi.fn();

		const result = await getNoteRaw(config, "noteId123456", onProgress);

		expect(result.encryptedBytes).toEqual(bodyBytes);
		expect(onProgress).toHaveBeenCalledTimes(2);
		expect(onProgress).toHaveBeenCalledWith(mid / bodyBytes.length);
		expect(onProgress).toHaveBeenCalledWith(1);
	});

	test("falls back to arrayBuffer when onProgress given but Content-Length is 0", async () => {
		const bodyBytes = new Uint8Array([1, 2, 3]);
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(rawResponse(bodyBytes, defaultHeaders)),
		);
		const config = createConfig(fetchMock);
		const onProgress = vi.fn();

		const result = await getNoteRaw(config, "noteId123456", onProgress);

		expect(result.encryptedBytes).toEqual(bodyBytes);
		expect(onProgress).not.toHaveBeenCalled();
	});

	test("throws SecretApiError when X-Client-Nonce contains invalid base64", async () => {
		const bodyBytes = new Uint8Array([1, 2, 3]);
		const headersWithBadNonce: Record<string, string> = {
			...defaultHeaders,
			"X-Client-Nonce": "!!!invalid-base64!!!",
		};
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(rawResponse(bodyBytes, headersWithBadNonce)),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteRaw(config, "noteId123456"));
		expect(err.message).toBe("Invalid base64 encoding in response");
		expect(err.status).toBe(502);
	});
});

describe("deleteNote", () => {
	test("resolves on successful delete", async () => {
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse({ deleted: true })));
		const config = createConfig(fetchMock);

		await expect(deleteNote(config, "noteId123456", "del-token")).resolves.toBeUndefined();

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes/noteId123456");
		expect((init as RequestInit).method).toBe("DELETE");
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["X-Delete-Token"]).toBe("del-token");
	});

	test("includes Authorization header when apiKey is set", async () => {
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse({ deleted: true })));
		const config = createConfig(fetchMock, "del-key");

		await deleteNote(config, "noteId123456", "del-token");

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer del-key");
	});

	test("throws SecretApiError on failure with error message", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(403, { error: "Invalid delete token" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(deleteNote(config, "noteId123456", "bad"));
		expect(err.message).toBe("Invalid delete token");
		expect(err.status).toBe(403);
	});

	test("throws SecretApiError with HTTP status fallback when no error field", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(500, { detail: "internal" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(deleteNote(config, "noteId123456", "tok"));
		expect(err.message).toBe("HTTP 500");
	});

	test("throws SecretApiError with fallback when error response is not JSON", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response("server error", { status: 500 })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(deleteNote(config, "noteId123456", "tok"));
		expect(err.message).toMatch(/^HTTP \d+$/);
	});
});

describe("initChunkedUpload", () => {
	test("sends POST with metadata and returns uploadId", async () => {
		const responseBody = { uploadId: "upload-123", expiresAt: "2099-01-01T00:00:00Z" };
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(responseBody)));
		const config = createConfig(fetchMock);

		const result = await initChunkedUpload(config, {
			streamHeader: "header-b64",
			chunkCount: 3,
			hasPassword: false,
			expiresIn: 86400,
			maxReads: 1,
			fileCount: 0,
		});

		expect(result).toEqual(responseBody);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes/upload/init");
		expect((init as RequestInit).method).toBe("POST");
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
	});

	test("includes auth headers when apiKey and capToken are provided", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(okResponse({ uploadId: "u1", expiresAt: "" })),
		);
		const config = createConfig(fetchMock, "init-key");

		await initChunkedUpload(config, { chunkCount: 1 }, "cap-tok-123");

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer init-key");
		expect(headers["X-Cap-Token"]).toBe("cap-tok-123");
	});

	test("throws SecretApiError on error response", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(400, { error: "Invalid metadata" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(initChunkedUpload(config, {}));
		expect(err.message).toBe("Invalid metadata");
		expect(err.status).toBe(400);
	});
});

describe("uploadChunk", () => {
	test("sends PUT with binary data and chunk hash", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(null, { status: 204 })),
		);
		const config = createConfig(fetchMock);
		const data = new Uint8Array([1, 2, 3, 4]);

		await uploadChunk(config, "upload-123", 0, data, "abc123hash");

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes/upload/upload-123/chunks/0");
		expect((init as RequestInit).method).toBe("PUT");
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/octet-stream");
		expect(headers["X-Chunk-Hash"]).toBe("abc123hash");
	});

	test("includes Authorization header when apiKey is set", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(null, { status: 204 })),
		);
		const config = createConfig(fetchMock, "chunk-key");

		await uploadChunk(config, "u1", 2, new Uint8Array([5]), "hash");

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer chunk-key");
	});

	test("throws SecretApiError on error response", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(400, { error: "Hash mismatch" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(uploadChunk(config, "u1", 0, new Uint8Array([1]), "bad-hash"));
		expect(err.message).toBe("Hash mismatch");
		expect(err.status).toBe(400);
	});

	test("throws SecretApiError with fallback when error response is not JSON", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response("server error", { status: 500 })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(uploadChunk(config, "u1", 0, new Uint8Array([1]), "hash"));
		expect(err.message).toMatch(/^HTTP \d+$/);
		expect(err.status).toBe(500);
	});

	test("throws SecretApiError with HTTP status fallback when no error field", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(500, { detail: "internal" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(uploadChunk(config, "u1", 0, new Uint8Array([1]), "hash"));
		expect(err.message).toBe("HTTP 500");
		expect(err.status).toBe(500);
	});
});

describe("completeChunkedUpload", () => {
	test("sends POST to complete endpoint and returns response", async () => {
		const responseBody = {
			id: "note-abc",
			expiresAt: "2099-01-01T00:00:00Z",
			deleteToken: "del-tok",
		};
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(responseBody)));
		const config = createConfig(fetchMock);

		const result = await completeChunkedUpload(config, "upload-123");

		expect(result).toEqual(responseBody);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes/upload/upload-123/complete");
		expect((init as RequestInit).method).toBe("POST");
	});

	test("includes auth headers when apiKey and capToken are provided", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(okResponse({ id: "x", expiresAt: "", deleteToken: "" })),
		);
		const config = createConfig(fetchMock, "complete-key");

		await completeChunkedUpload(config, "u1", "cap-complete");

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer complete-key");
		expect(headers["X-Cap-Token"]).toBe("cap-complete");
	});

	test("throws SecretApiError on error response", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(404, { error: "Upload not found" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(completeChunkedUpload(config, "bad-id"));
		expect(err.message).toBe("Upload not found");
		expect(err.status).toBe(404);
	});
});

describe("getNoteStream", () => {
	function buildLengthPrefixedBody(chunks: Uint8Array[]): ArrayBuffer {
		let totalSize = 0;
		for (const chunk of chunks) {
			totalSize += 4 + chunk.length;
		}
		const buffer = new ArrayBuffer(totalSize);
		const view = new DataView(buffer);
		const bytes = new Uint8Array(buffer);
		let offset = 0;
		for (const chunk of chunks) {
			view.setUint32(offset, chunk.length);
			offset += 4;
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return buffer;
	}

	const streamHeaders: Record<string, string> = {
		"X-Stream-Header": "c3RyZWFtLWhlYWRlcg==",
		"X-Chunk-Count": "2",
		"X-Has-Password": "false",
		"X-File-Count": "1",
		"X-Created-At": "2024-01-01T00:00:00Z",
		"X-Expires-At": "2099-01-01T00:00:00Z",
	};

	test("parses length-prefixed chunks from response body", async () => {
		const chunk1 = new Uint8Array([10, 20, 30]);
		const chunk2 = new Uint8Array([40, 50]);
		const body = buildLengthPrefixedBody([chunk1, chunk2]);

		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(body, { status: 200, headers: streamHeaders })),
		);
		const config = createConfig(fetchMock);

		const result = await getNoteStream(config, "noteId123456");

		expect(result.streamHeader).toBe("c3RyZWFtLWhlYWRlcg==");
		expect(result.chunkCount).toBe(2);
		expect(result.hasPassword).toBe(false);
		expect(result.fileCount).toBe(1);
		expect(result.createdAt).toBe("2024-01-01T00:00:00Z");
		expect(result.expiresAt).toBe("2099-01-01T00:00:00Z");
		expect(result.chunks).toHaveLength(2);
		expect(result.chunks[0]).toEqual(chunk1);
		expect(result.chunks[1]).toEqual(chunk2);
		expect(result.salt).toBeUndefined();

		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes/noteId123456/stream");
	});

	test("includes salt when X-Salt header is present", async () => {
		const body = buildLengthPrefixedBody([new Uint8Array([1])]);
		const headersWithSalt = { ...streamHeaders, "X-Chunk-Count": "1", "X-Salt": "mySalt" };

		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(body, { status: 200, headers: headersWithSalt })),
		);
		const config = createConfig(fetchMock);

		const result = await getNoteStream(config, "noteId123456");

		expect(result.salt).toBe("mySalt");
	});

	test("includes hasPassword when X-Has-Password is true", async () => {
		const body = buildLengthPrefixedBody([new Uint8Array([1])]);
		const headersWithPw = {
			...streamHeaders,
			"X-Chunk-Count": "1",
			"X-Has-Password": "true",
		};

		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(body, { status: 200, headers: headersWithPw })),
		);
		const config = createConfig(fetchMock);

		const result = await getNoteStream(config, "noteId123456");

		expect(result.hasPassword).toBe(true);
	});

	test("calls onProgress for each chunk parsed", async () => {
		const chunk1 = new Uint8Array([1, 2]);
		const chunk2 = new Uint8Array([3, 4]);
		const chunk3 = new Uint8Array([5]);
		const body = buildLengthPrefixedBody([chunk1, chunk2, chunk3]);
		const headers3 = { ...streamHeaders, "X-Chunk-Count": "3" };

		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(body, { status: 200, headers: headers3 })),
		);
		const config = createConfig(fetchMock);
		const onProgress = vi.fn();

		await getNoteStream(config, "noteId123456", onProgress);

		expect(onProgress).toHaveBeenCalledTimes(3);
		expect(onProgress).toHaveBeenNthCalledWith(1, 1 / 3);
		expect(onProgress).toHaveBeenNthCalledWith(2, 2 / 3);
		expect(onProgress).toHaveBeenNthCalledWith(3, 1);
	});

	test("throws SecretApiError on error response", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(400, { error: "Not a chunked note" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteStream(config, "noteId123456"));
		expect(err.message).toBe("Not a chunked note");
		expect(err.status).toBe(400);
	});

	test("throws SecretApiError with fallback when error response is not JSON", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response("bad", { status: 500 })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteStream(config, "noteId123456"));
		expect(err.message).toMatch(/^HTTP \d+$/);
		expect(err.status).toBe(500);
	});

	test("handles empty body with 0 chunk count", async () => {
		const body = new ArrayBuffer(0);
		const emptyHeaders = { ...streamHeaders, "X-Chunk-Count": "0" };

		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(body, { status: 200, headers: emptyHeaders })),
		);
		const config = createConfig(fetchMock);

		const result = await getNoteStream(config, "noteId123456");

		expect(result.chunks).toHaveLength(0);
		expect(result.chunkCount).toBe(0);
	});

	test("throws when required response headers are missing", async () => {
		const body = new ArrayBuffer(0);

		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(body, { status: 200, headers: {} })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteStream(config, "noteId123456"));
		expect(err.message).toContain("Missing required header");
	});

	test("includes Authorization header when apiKey is set", async () => {
		const body = new ArrayBuffer(0);

		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(
				new Response(body, {
					status: 200,
					headers: {
						"X-Stream-Header": "hdr",
						"X-Chunk-Count": "0",
						"X-Created-At": "2024-01-01T00:00:00Z",
						"X-Expires-At": "2024-01-02T00:00:00Z",
					},
				}),
			),
		);
		const config = createConfig(fetchMock, "stream-key");

		await getNoteStream(config, "noteId123456");

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer stream-key");
	});

	test("throws SecretApiError with HTTP status fallback when no error field", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(403, { detail: "forbidden" })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteStream(config, "noteId123456"));
		expect(err.message).toBe("HTTP 403");
		expect(err.status).toBe(403);
	});

	test("throws on truncated body where length prefix exceeds buffer", async () => {
		const body = new ArrayBuffer(2);
		const truncatedHeaders = { ...streamHeaders, "X-Chunk-Count": "2" };

		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(body, { status: 200, headers: truncatedHeaders })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteStream(config, "noteId123456"));
		expect(err.status).toBe(502);
		expect(err.message).toContain("Expected 2 chunks");
	});

	test("throws on truncated body where chunk data exceeds buffer", async () => {
		const buffer = new ArrayBuffer(14); // 4 bytes length + 10 bytes data
		const view = new DataView(buffer);
		view.setUint32(0, 100); // claims chunk is 100 bytes
		const truncatedHeaders = { ...streamHeaders, "X-Chunk-Count": "2" };

		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(buffer, { status: 200, headers: truncatedHeaders })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteStream(config, "noteId123456"));
		expect(err.status).toBe(502);
		expect(err.message).toContain("Expected 2 chunks");
	});

	test("throws when X-Chunk-Count exceeds maximum", async () => {
		const hugeHeaders = { ...streamHeaders, "X-Chunk-Count": "10001" };
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(new ArrayBuffer(0), { status: 200, headers: hugeHeaders })),
		);
		const config = createConfig(fetchMock);

		const err = await catchApiError(getNoteStream(config, "noteId123456"));
		expect(err.status).toBe(502);
		expect(err.message).toContain("exceeds maximum");
	});
});

describe("request policy (timeout + retry)", () => {
	function policyConfig(
		fetchMock: typeof fetch,
		extra: Partial<HttpClientConfig>,
	): HttpClientConfig {
		return { baseUrl: "https://api.example.com", fetch: fetchMock, ...extra };
	}

	test("retries idempotent GET on 5xx then succeeds", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(errorResponse(503, { error: "down" }))
			.mockResolvedValueOnce(errorResponse(500, { error: "down" }))
			.mockResolvedValueOnce(okResponse({ ok: true }));
		const config = policyConfig(fetchMock, { maxRetries: 3, retryBackoffMs: () => 0 });

		const result = await getJson<{ ok: boolean }>(config, "/notes/x");

		expect(result).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	test("retries idempotent GET on network error then succeeds", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("network down"))
			.mockResolvedValueOnce(okResponse({ ok: true }));
		const config = policyConfig(fetchMock, { maxRetries: 2, retryBackoffMs: () => 0 });

		const result = await getJson<{ ok: boolean }>(config, "/notes/x");

		expect(result).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("returns the final 5xx response after exhausting retries", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(errorResponse(500, { error: "still down" }));
		const config = policyConfig(fetchMock, { maxRetries: 2, retryBackoffMs: () => 0 });

		const err = await catchApiError(getJson(config, "/notes/x"));
		expect(err.status).toBe(500);
		expect(err.message).toBe("still down");
		// maxRetries: 2 → 3 attempts total (initial + 2 retries).
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	test("retries idempotent chunk PUT on 5xx", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(errorResponse(502, { error: "bad gateway" }))
			.mockResolvedValueOnce(okResponse({}));
		const config = policyConfig(fetchMock, { maxRetries: 2, retryBackoffMs: () => 0 });

		await uploadChunk(config, "upload1", 0, new Uint8Array([1, 2, 3]), "hash");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("does not retry non-idempotent POST on 5xx", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(errorResponse(503, { error: "down" }));
		const config = policyConfig(fetchMock, { maxRetries: 5, retryBackoffMs: () => 0 });

		const err = await catchApiError(postJson(config, "/notes", { data: "x" }));
		expect(err.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	test("does not retry non-idempotent POST on network error", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network down"));
		const config = policyConfig(fetchMock, { maxRetries: 5, retryBackoffMs: () => 0 });

		// A transport failure now arrives as a typed SecretNetworkError carrying
		// the original as `cause`, instead of a bare TypeError callers could not
		// classify.
		const err = await postJson(config, "/notes", { data: "x" }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SecretNetworkError);
		expect((err as SecretNetworkError).message).toBe("Network request failed");
		expect((err as SecretNetworkError).cause).toBeInstanceOf(TypeError);
		expect(((err as SecretNetworkError).cause as Error).message).toBe("network down");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	test("aborts the request after timeoutMs", async () => {
		const fetchMock = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					const signal = (init as RequestInit).signal as AbortSignal;
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const config = policyConfig(fetchMock, { timeoutMs: 10 });

		// A timeout surfaces as a typed SecretApiError, not the raw AbortError.
		const err = await catchApiError(getJson(config, "/notes/x"));
		expect(err).toBeInstanceOf(SecretApiError);
		expect(err.message).toBe("Request timed out");
	});

	test("uses the default backoff when none is configured", async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(errorResponse(500, { error: "down" }))
				.mockResolvedValueOnce(okResponse({ ok: true }));
			const config = policyConfig(fetchMock, { maxRetries: 2 });

			const promise = getJson<{ ok: boolean }>(config, "/notes/x");
			// Default backoff for attempt 1 is 2**1 * 250 = 500ms.
			await vi.advanceTimersByTimeAsync(500);
			const result = await promise;

			expect(result).toEqual({ ok: true });
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
