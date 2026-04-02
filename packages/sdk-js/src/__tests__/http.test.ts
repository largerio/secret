import { describe, expect, test, vi } from "vitest";
import { SecretApiError } from "../errors.js";

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
});

describe("postFormData with XMLHttpRequest", () => {
	function createMockXhr() {
		const listeners: Record<string, Array<(e: unknown) => void>> = {};
		const uploadListeners: Record<string, Array<(e: unknown) => void>> = {};

		const xhr = {
			open: vi.fn(),
			send: vi.fn(),
			setRequestHeader: vi.fn(),
			status: 200,
			responseText: "",
			upload: {
				addEventListener: vi.fn((event: string, handler: (e: unknown) => void) => {
					uploadListeners[event] = uploadListeners[event] ?? [];
					uploadListeners[event]?.push(handler);
				}),
			},
			addEventListener: vi.fn((event: string, handler: (e: unknown) => void) => {
				listeners[event] = listeners[event] ?? [];
				listeners[event]?.push(handler);
			}),
		};

		function triggerEvent(event: string, data?: unknown) {
			for (const handler of listeners[event] ?? []) {
				handler(data);
			}
		}

		function triggerUploadEvent(event: string, data?: unknown) {
			for (const handler of uploadListeners[event] ?? []) {
				handler(data);
			}
		}

		return { xhr, triggerEvent, triggerUploadEvent };
	}

	function installXhr(xhrInstance: ReturnType<typeof createMockXhr>["xhr"]) {
		(globalThis as Record<string, unknown>)["XMLHttpRequest"] = function MockXMLHttpRequest() {
			return xhrInstance;
		};
	}

	function removeXhr() {
		delete (globalThis as Record<string, unknown>)["XMLHttpRequest"];
	}

	test("uses XHR when onProgress is provided and XMLHttpRequest exists", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);

		try {
			const config = createConfig(vi.fn<typeof fetch>(), "xhr-key");
			const formData = new FormData();
			const onProgress = vi.fn();

			const responseBody = { id: "xhr1", expiresAt: "2099-01-01", deleteToken: "tok" };
			xhr.status = 200;
			xhr.responseText = JSON.stringify(responseBody);

			const promise = postFormData(config, "/notes/upload", formData, onProgress);

			triggerEvent("load");

			const result = await promise;

			expect(result).toEqual(responseBody);
			expect(xhr.open).toHaveBeenCalledWith("POST", "https://api.example.com/notes/upload");
			expect(xhr.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer xhr-key");
			expect(xhr.send).toHaveBeenCalledWith(formData);
		} finally {
			removeXhr();
		}
	});

	test("does not set Authorization header when no apiKey", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);

		try {
			const config = createConfig(vi.fn<typeof fetch>());
			const formData = new FormData();
			const onProgress = vi.fn();

			xhr.status = 200;
			xhr.responseText = JSON.stringify({ id: "x", expiresAt: "", deleteToken: "" });

			const promise = postFormData(config, "/notes/upload", formData, onProgress);
			triggerEvent("load");
			await promise;

			expect(xhr.setRequestHeader).not.toHaveBeenCalled();
		} finally {
			removeXhr();
		}
	});

	test("reports upload progress when lengthComputable", async () => {
		const { xhr, triggerEvent, triggerUploadEvent } = createMockXhr();
		installXhr(xhr);

		try {
			const config = createConfig(vi.fn<typeof fetch>());
			const formData = new FormData();
			const onProgress = vi.fn();

			xhr.status = 200;
			xhr.responseText = JSON.stringify({ id: "x", expiresAt: "", deleteToken: "" });

			const promise = postFormData(config, "/notes/upload", formData, onProgress);

			triggerUploadEvent("progress", { lengthComputable: true, loaded: 50, total: 100 });
			triggerUploadEvent("progress", { lengthComputable: false, loaded: 60, total: 0 });
			triggerEvent("load");

			await promise;

			expect(onProgress).toHaveBeenCalledTimes(1);
			expect(onProgress).toHaveBeenCalledWith(0.5);
		} finally {
			removeXhr();
		}
	});

	test("rejects with SecretApiError on non-2xx status", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);

		try {
			const config = createConfig(vi.fn<typeof fetch>());
			const formData = new FormData();
			const onProgress = vi.fn();

			xhr.status = 400;
			xhr.responseText = JSON.stringify({ error: "Bad request" });

			const promise = postFormData(config, "/notes/upload", formData, onProgress);
			triggerEvent("load");

			const err = await catchApiError(promise);
			expect(err.message).toBe("Bad request");
			expect(err.status).toBe(400);
		} finally {
			removeXhr();
		}
	});

	test("rejects with fallback HTTP status when no error field in non-2xx response", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);

		try {
			const config = createConfig(vi.fn<typeof fetch>());
			const formData = new FormData();
			const onProgress = vi.fn();

			xhr.status = 500;
			xhr.responseText = JSON.stringify({ detail: "Internal error" });

			const promise = postFormData(config, "/notes/upload", formData, onProgress);
			triggerEvent("load");

			const err = await catchApiError(promise);
			expect(err.message).toBe("HTTP 500");
		} finally {
			removeXhr();
		}
	});

	test("rejects with 'Invalid response' when response is not valid JSON", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);

		try {
			const config = createConfig(vi.fn<typeof fetch>());
			const formData = new FormData();
			const onProgress = vi.fn();

			xhr.status = 200;
			xhr.responseText = "not json";

			const promise = postFormData(config, "/notes/upload", formData, onProgress);
			triggerEvent("load");

			const err = await catchApiError(promise);
			expect(err.message).toBe("Invalid JSON response");
			expect(err.status).toBe(200);
		} finally {
			removeXhr();
		}
	});

	test("rejects with 'Network error' on XHR error event", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);

		try {
			const config = createConfig(vi.fn<typeof fetch>());
			const formData = new FormData();
			const onProgress = vi.fn();

			const promise = postFormData(config, "/notes/upload", formData, onProgress);
			triggerEvent("error");

			const err = await catchApiError(promise);
			expect(err.message).toBe("Network error");
			expect(err.status).toBe(0);
		} finally {
			removeXhr();
		}
	});

	test("rejects with 'Upload cancelled' on XHR abort event", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);

		try {
			const config = createConfig(vi.fn<typeof fetch>());
			const formData = new FormData();
			const onProgress = vi.fn();

			const promise = postFormData(config, "/notes/upload", formData, onProgress);
			triggerEvent("abort");

			const err = await catchApiError(promise);
			expect(err.message).toBe("Upload cancelled");
			expect(err.status).toBe(0);
		} finally {
			removeXhr();
		}
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
		};
		const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(info)));
		const config = createConfig(fetchMock);

		const result = await checkNote(config, "noteId123456");

		expect(result).toEqual(info);
		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.example.com/notes/noteId123456/exists");
	});

	test("returns default on non-ok response", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(errorResponse(404, { error: "Not found" })),
		);
		const config = createConfig(fetchMock);

		const result = await checkNote(config, "missing12345");

		expect(result).toEqual({
			exists: false,
			hasPassword: false,
			fileCount: 0,
			expiresAt: "",
			maxReads: 1,
		});
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

	test("includes Authorization header when apiKey is set", async () => {
		const fetchMock = vi.fn<typeof fetch>(() =>
			Promise.resolve(
				okResponse({ exists: true, hasPassword: false, fileCount: 0, expiresAt: "", maxReads: 1 }),
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
