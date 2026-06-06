import { afterEach, describe, expect, test, vi } from "vitest";

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

afterEach(() => {
	removeXhr();
});

describe("isXhrAvailable", () => {
	test("returns false when XMLHttpRequest is not defined", async () => {
		const { isXhrAvailable } = await import("../xhr.js");
		expect(isXhrAvailable()).toBe(false);
	});

	test("returns true when XMLHttpRequest is defined", async () => {
		const { xhr } = createMockXhr();
		installXhr(xhr);
		const { isXhrAvailable } = await import("../xhr.js");
		expect(isXhrAvailable()).toBe(true);
	});
});

describe("postFormDataXhr", () => {
	test("resolves with parsed JSON on success", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);
		const { postFormDataXhr } = await import("../xhr.js");

		const responseBody = { id: "x1", expiresAt: "2099-01-01", deleteToken: "tok" };
		xhr.status = 200;
		xhr.responseText = JSON.stringify(responseBody);

		const formData = new FormData();
		const onProgress = vi.fn();
		const promise = postFormDataXhr("https://example.com/upload", {}, formData, onProgress);

		triggerEvent("load");

		const result = await promise;
		expect(result).toEqual(responseBody);
		expect(xhr.open).toHaveBeenCalledWith("POST", "https://example.com/upload");
		expect(xhr.send).toHaveBeenCalledWith(formData);
	});

	test("sets request headers", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);
		const { postFormDataXhr } = await import("../xhr.js");

		xhr.status = 200;
		xhr.responseText = JSON.stringify({ id: "x", expiresAt: "", deleteToken: "" });

		const promise = postFormDataXhr(
			"https://example.com/upload",
			{ Authorization: "Bearer key" },
			new FormData(),
			vi.fn(),
		);
		triggerEvent("load");
		await promise;

		expect(xhr.setRequestHeader).toHaveBeenCalledWith("Authorization", "Bearer key");
	});

	test("reports upload progress", async () => {
		const { xhr, triggerEvent, triggerUploadEvent } = createMockXhr();
		installXhr(xhr);
		const { postFormDataXhr } = await import("../xhr.js");

		xhr.status = 200;
		xhr.responseText = JSON.stringify({ id: "x", expiresAt: "", deleteToken: "" });

		const onProgress = vi.fn();
		const promise = postFormDataXhr("https://example.com/upload", {}, new FormData(), onProgress);

		triggerUploadEvent("progress", { lengthComputable: true, loaded: 50, total: 100 });
		triggerUploadEvent("progress", { lengthComputable: false, loaded: 60, total: 0 });
		triggerEvent("load");
		await promise;

		expect(onProgress).toHaveBeenCalledTimes(1);
		expect(onProgress).toHaveBeenCalledWith(0.5);
	});

	test("rejects with error from response body on non-2xx", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);
		const { postFormDataXhr } = await import("../xhr.js");

		xhr.status = 400;
		xhr.responseText = JSON.stringify({ error: "Bad request" });

		const promise = postFormDataXhr("https://example.com/upload", {}, new FormData(), vi.fn());
		triggerEvent("load");

		await expect(promise).rejects.toThrow("Bad request");
	});

	test("rejects with HTTP status fallback when error is not a string", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);
		const { postFormDataXhr } = await import("../xhr.js");

		xhr.status = 500;
		xhr.responseText = JSON.stringify({ detail: "oops" });

		const promise = postFormDataXhr("https://example.com/upload", {}, new FormData(), vi.fn());
		triggerEvent("load");

		await expect(promise).rejects.toThrow("HTTP 500");
	});

	test("rejects with Invalid JSON when response is not parseable", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);
		const { postFormDataXhr } = await import("../xhr.js");

		xhr.status = 200;
		xhr.responseText = "not json";

		const promise = postFormDataXhr("https://example.com/upload", {}, new FormData(), vi.fn());
		triggerEvent("load");

		await expect(promise).rejects.toThrow("Invalid JSON response");
	});

	test("rejects with Network error on XHR error event", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);
		const { postFormDataXhr } = await import("../xhr.js");

		const promise = postFormDataXhr("https://example.com/upload", {}, new FormData(), vi.fn());
		triggerEvent("error");

		await expect(promise).rejects.toThrow("Network error");
	});

	test("rejects with Upload cancelled on XHR abort event", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);
		const { postFormDataXhr } = await import("../xhr.js");

		const promise = postFormDataXhr("https://example.com/upload", {}, new FormData(), vi.fn());
		triggerEvent("abort");

		await expect(promise).rejects.toThrow("Upload cancelled");
	});

	test("sets xhr.timeout and rejects on timeout event when timeoutMs is given", async () => {
		const { xhr, triggerEvent } = createMockXhr();
		installXhr(xhr);
		const { postFormDataXhr } = await import("../xhr.js");

		const promise = postFormDataXhr(
			"https://example.com/upload",
			{},
			new FormData(),
			vi.fn(),
			5000,
		);
		expect((xhr as unknown as { timeout: number }).timeout).toBe(5000);
		triggerEvent("timeout");

		await expect(promise).rejects.toThrow("Upload timed out");
	});
});
