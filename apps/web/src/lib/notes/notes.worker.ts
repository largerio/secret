import type { Answer, Request } from "#lib/notes/protocol.js";
import { handle } from "#lib/notes/worker.js";

// The worker that encrypts and decrypts notes: Argon2id and the ciphers run
// here, off the page's thread, and the files a read decrypts go to disk.
self.addEventListener("message", (event: MessageEvent<Request>) => {
	void handle(event.data, (answer: Answer) => self.postMessage(answer));
});
self.postMessage({ kind: "ready" } satisfies Answer);
